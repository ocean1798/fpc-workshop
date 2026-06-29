# FPC 工坊 — 架构与数据流文档

> 本文档面向插件开发者，覆盖选中→读取→变换→还原的完整逻辑链条，包含 API 调用方式、数据结构、状态机设计和关键决策理由。

## 目录

- [1. 架构概览](#1-架构概览)
- [2. 状态机](#2-状态机)
- [3. 核心数据结构](#3-核心数据结构)
  - [3.1 State 对象](#31-state-对象)
  - [3.2 Pad 条目对象](#32-pad-条目对象)
  - [3.3 备份数据对象](#33-备份数据对象)
- [4. 启动与轮询 (Polling)](#4-启动与轮询-polling)
- [5. 读取焊盘数据](#5-读取焊盘数据)
  - [5.1 fetchSelectedPads()](#51-fetchselectedpads)
  - [5.2 readPadState() — 读取单个焊盘原始数据](#52-readpadstate--读取单个焊盘原始数据)
  - [5.3 Tuple 辅助函数](#53-tuple-辅助函数)
  - [5.4 封装焊盘获取 — getComponentPadObjects()](#54-封装焊盘获取--getcomponentpadobjects)
- [6. 应用变换](#6-应用变换)
  - [6.1 applyTransform() 主流程](#61-applytransform-主流程)
  - [6.2 buildNewShape() — 尺寸 → API tuple](#62-buildnewshape--尺寸--api-tuple)
  - [6.3 buildNewMask() — maskExpansion → API mask 对象](#63-buildnewmask--maskexpansion--api-mask-对象)
  - [6.4 核心写入 API：modify()](#64-核心写入-apimodify)
- [7. 还原变换](#7-还原变换)
- [8. 单位换算链路](#8-单位换算链路)
- [9. 完整数据流时序](#9-完整数据流时序)
- [10. 关键设计决策](#10-关键设计决策)

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│  EasyEDA PCB 画布                     │  FPC 工坊 iframe          │
│                                       │                          │
│  pcb_SelectControl ◄── 200ms 轮询 ──►│ startPolling()           │
│  IPCB_PrimitivePad                   │   ↓                      │
│  IPCB_PrimitiveComponentPad          │ fetchSelectedPads()  ────┤ 读取 (R)
│       ↑                              │   ↓                      │
│       │   modify()                   │ renderPadTable()         │
│       └──────────────────────────────│   ↓                      │
│          (原子写入)                   │ applyTransform()  ───────┤ 写入 (U)
│                                      │ restoreTransform() ──────┤ 还原
└─────────────────────────────────────────────────────────────────┘
```

插件运行在 EasyEDA 的 iframe 沙箱中，通过 `eda.*` 全局 API 对象与画布交互。插件本身不持有任何画布状态，所有数据始终从画布实时读取。

---

## 2. 状态机

插件有 4 个稳定状态 + 1 个临时状态：

```
        ┌──────────┐
        │   idle   │  ← 初始状态 / 还原后
        └────┬─────┘
             │ 选中焊盘
             ▼
        ┌──────────┐
   ┌───►│  ready   │  ← 有焊盘选中，等待用户操作
   │    └────┬─────┘
   │         │ 用户点击「应用」
   │         ▼
   │    ┌──────────────┐
   │    │  processing  │  ← 正在修改焊盘（锁定所有按钮）
   │    └──┬───┬───┬───┘
   │       │   │   │
   │  成功 │   │   │ 失败
   │       ▼   │   ▼
   │  ┌──────┐│┌──────┐
   └──│success│││error │
      └──────┘│└──┬───┘
              │   │
              └───┘  (自动回到 ready)
```

**状态转换规则：**

| 当前状态 | 允许操作 | 阻塞的操作 |
|---------|---------|-----------|
| `idle` | 无（等待画布选中） | apply, restore |
| `ready` | apply, restore（如有备份） | — |
| `processing` | 无 | **全部阻塞** |
| `success` | 继续 apply, restore | — |
| `error` | 继续 apply, restore | — |

**代码位置:** [`iframe/index.html`](iframe/index.html) StateMachine 对象

---

## 3. 核心数据结构

### 3.1 State 对象

```typescript
// [index.html:1038-1050]
const state = {
	padList: Array<PadEntry>, // 当前焊盘列表
	selectedIds: Set<string>, // 用户勾选的焊盘 ID 集合
	backupData: BackupData | null, // 首次 apply 时创建的原始数据备份
	isLocked: boolean, // 长宽联动锁定
	isProcessing: boolean, // 正在执行操作中
	deltaX: number, // X 方向增量 (mm/mil)
	deltaY: number, // Y 方向增量 (mm/mil)
	maskExpansion: number, // 阻焊扩展值 (mm/mil)
	edaConnected: boolean, // EDA 连接状态
	pollTimer: number | null, // 轮询定时器 ID
	lastSelectedSignature: string // 上次选中 ID 签名
};
```

### 3.2 Pad 条目对象

每个焊盘在读取后被组装成以下结构：

```typescript
{
    id:              string,    // "abc123" — 图元唯一标识
    type:            string,    // "RECT" | "ELLIPSE" | "OVAL" | "NGON"
    width:           number,    // 3.00 — 当前宽度 (显示单位)
    height:          number,    // 1.50 — 当前高度 (显示单位)
    originalWidth:   number,    // 3.00 — 首次读取时的宽度 (基准值)
    originalHeight:  number,    // 1.50 — 首次读取时的高度 (基准值)
    originalMask:    object|null, // 原始阻焊/助焊扩展 (null = 遵循规则)
    edaObj:          IPCB_PrimitivePad, // EDA 原生图元对象引用
    edaShape:        tuple,     // ["RECT", 118, 59, 4] — 原始 shape tuple (mil)
    edaMask:         object|null, // 原始 mask 对象
    primitiveIdStr:  string,    // 用于 modify() 调用
    unit:            string     // "mm" | "mil"
}
```

### 3.3 备份数据对象

```typescript
{
	pads: Array<{
		id: string; // 焊盘 ID
		primitiveIdStr: string; // modify() 所需标识
		originalShape: tuple; // 深拷贝的原始 shape tuple
		originalMask: object | null; // 原始 mask (null = 遵循规则)
	}>;
}
```

---

## 4. 启动与轮询 (Polling)

### 4.1 初始化流程

```
用户打开插件 iframe
    │
    ▼
init()
    ├─ 1. 检查 EDA 可用性 (getEda())
    ├─ 2. 开始轮询 startPolling()
    ├─ 3. 加载主题 (localStorage)
    ├─ 4. 绑定事件
    │     ├─ lockBtn       → 切换联动锁定
    │     ├─ deltaXInput   → 联动 deltaY, maskExpansion
    │     ├─ applyBtn      → applyTransform()
    │     ├─ restoreBtn    → restoreTransform()
    │     └─ themeToggle   → toggleTheme()
    └─ 5. 初始状态: idle
```

### 4.2 轮询机制

这是插件的「眼睛」——持续感知画布选中变化：

```javascript
// [index.html:1446-1470]
setInterval(async () => {
	// ① 获取当前选中的所有图元 ID
	const ids = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();

	// ② 标准化 + 排序 → 生成 ID 签名
	//    如: ["pad-3", "pad-1"] → "pad-1|pad-3"
	const signature = normalizedIds.join('|');

	// ③ 与上一次签名比较 (不是比较数量!)
	if (signature !== state.lastSelectedSignature) {
		state.lastSelectedSignature = signature;

		if (normalizedIds.length > 0) {
			await fetchSelectedPads(); // 有选中 → 完整读取
		}
		else {
			clearPadList(); // 无选中 → 清空列表
		}
	}
}, 200); // 200ms 间隔
```

> **设计理由:** 选用 ID 签名而非数量比较。早期版本只比较 `ids.length`，选中焊盘 A → 切换选中焊盘 B（数量相同）时不触发刷新。ID 签名 `"pad-1|pad-2"` 能精确区分「选中了哪些图元」。

### 4.3 轮询周期

| 参数 | 值 | 说明 |
|------|-----|------|
| 间隔 | 200ms | 平衡响应速度与 CPU 开销 |
| 比较键 | ID 签名 `join('|')` | 精确检测选中变化 |
| 触发条件 | 签名变化 + 非空 | 避免不必要的完整读取 |

---

## 5. 读取焊盘数据

### 5.1 fetchSelectedPads()

核心读取链路，分两条路径处理直接焊盘和封装内焊盘：

```
                    fetchSelectedPads()
                           │
                           ▼
            ┌──────────────────────────┐
            │ eda.pcb_SelectControl    │
            │ .getAllSelectedPrimitives()│
            └──────────┬───────────────┘
                       │
               遍历每个选中图元
                       │
          ┌────────────┴────────────┐
          │                         │
          ▼                         ▼
   ┌──────────────┐         ┌──────────────┐
   │ 情况A: 焊盘   │         │ 情况B: 封装   │
   │ (有 setState │         │ (无 setState │
   │  _Pad 方法)  │         │  _Pad 方法)  │
   └──────┬───────┘         └──────┬───────┘
          │                        │
          ▼                        ▼
   readPadState(obj)        getComponentPadObjects(eda, obj)
          │                        │
          │                 ┌──────┴──────┐
          │                 │ 优先级链:    │
          │                 │ 1. getAllPins()
          │                 │ 2. getState_Pads()
          │                 │ 3. getAllPinsByPrimitiveId()
          │                 │ 4. getComponentPads()
          │                 │ 5. componentPads
          │                 │ 6. pads
          │                 └──────┬──────┘
          │                        │
          │                 遍历每个子焊盘
          │                        │
          │                 readPadState(cpObj)
          │                        │
          └────────┬───────────────┘
                   │
                   ▼
            组装 pad 对象
```

**识别方式:** 通过 `typeof obj.setState_Pad === 'function'` 判断是否为焊盘图元。封装类图元没有此方法，进入 else 分支获取内部焊盘。

**跳过规则:** `POLYGON` 和 `POLYLINE_COMPLEX_POLYGON` 类型焊盘被跳过（不支持非矩形缩放），计数通过 `skippedComplexCount` 记录并提示用户。

### 5.2 readPadState() — 读取单个焊盘原始数据

```javascript
// [index.html:1131-1158]
function readPadState(edaObj) {
	// ① 读取焊盘形状 → tuple
	const shape = edaObj.getState_Pad();
	// 返回: ["RECT", 118, 59, 4] | ["ELLIPSE", 50, 30] | ["OVAL", 80, 40]
	//       ["NGON", 60, 6] | null

	// ② 校验: 必须是数组且长度 ≥ 2
	if (!Array.isArray(shape) || shape.length < 2)
		return null;

	// ③ 读取阻焊/助焊扩展 → 对象或 null
	const mask = edaObj.getState_SolderMaskAndPasteMaskExpansion();
	// 返回: {topSolderMask: 10, bottomSolderMask: 10} | null
	//       null = "遵循设计规则"（不是 {}！）

	return { shape, mask };
	// mask 保留 null，不转为 {}
}
```

> **关键细节:** `mask: null` 与 `mask: {}` 语义完全不同。`null` 表示焊盘遵循全局设计规则中的阻焊/助焊扩展设置；`{}` 表示自定义模式但未设置具体值。将 null 转为 {} 会导致：（1）还原时无法恢复「遵循规则」模式；（2）备份数据失真。

### 5.3 Tuple 辅助函数

EasyEDA PCB API 中的焊盘形状以 tuple 数组表示，需要辅助函数提取字段：

| 函数 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `getShapeType(shape)` | `["RECT", w, h, r]` | `"RECT"` | 取 `shape[0]` |
| `getShapeWidth(shape)` | `["RECT", 118, 59, 4]` | `118` | RECT/ELLIPSE/OVAL: `shape[1]`; NGON: `shape[1]`; POLYGON: `0` |
| `getShapeHeight(shape)` | `["RECT", 118, 59, 4]` | `59` | RECT: `shape[2]`; ELLIPSE/OVAL: `shape[2] \|\| shape[1]`; NGON: `shape[1]`; POLYGON: `0` |

**支持的 shape tuple 格式：**

| shape[0] | 格式 | 说明 |
|----------|------|------|
| `RECT` | `["RECT", width, height, roundRadius?]` | 矩形焊盘 |
| `ELLIPSE` | `["ELLIPSE", width, height]` | 椭圆焊盘 |
| `OVAL` | `["OVAL", width, height]` | 长圆形焊盘（`OBLONG` 枚举值也是 `"OVAL"`） |
| `NGON` | `["NGON", diameter, sides]` | 正多边形焊盘 |
| `POLYGON` | `["POLYGON", complexPolygon]` | 复杂多边形 (不支持变换) |

### 5.4 封装焊盘获取 — getComponentPadObjects()

```javascript
// [index.html:1249-1284]
async function getComponentPadObjects(eda, componentObj) {
	// 优先级链:
	if (typeof componentObj.getAllPins === 'function') { // ① 首选
		componentPads = await componentObj.getAllPins();
	}
	else if (typeof componentObj.getState_Pads === 'function') { // ②
		componentPads = componentObj.getState_Pads();
	}
	else if (eda.pcb_PrimitiveComponent && typeof eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId === 'function') { // ③ 静态方法
		const componentId = componentObj.primitiveId || componentObj.id || componentObj.uuid;
		if (componentId)
			componentPads = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId);
	}
	else if (typeof componentObj.getComponentPads === 'function') { // ④ 兼容
		componentPads = componentObj.getComponentPads();
	}
	else if (componentObj.componentPads) { // ⑤ 兼容
		componentPads = componentObj.componentPads;
	}
	else if (componentObj.pads) { // ⑥ fallback
		componentPads = componentObj.pads;
	}
}
```

返回结果经过类型规范化处理，确保始终返回标准 `Array<IPCB_PrimitiveComponentPad>`。

---

## 6. 应用变换

### 6.1 applyTransform() 主流程

```
                    用户点击「应用」
                         │
                         ▼
              ┌─────────────────────┐
              │ ① 状态检查           │
              │   - isProcessing?   │
              │   - EDA 连接?        │
              │   - 焊盘列表非空?     │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ ② 重新读取完整数据    │
              │   await             │
              │   fetchSelectedPads()│  ← 确保数据最新
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ ③ 创建备份 (首次)    │
              │   深拷贝 edaShape +  │
              │   保留 edaMask      │
              └──────────┬──────────┘
                         │
              ┌───────────▼───────────┐
              │ ④ 遍历每个焊盘         │
              │                       │
              │  ┌─────────────────┐  │
              │  │ a. 取基准尺寸    │  │  ← 从 backup.originalShape 取
              │  │    (防累积叠加)  │  │     不是从 pad.width 取
              │  ├─────────────────┤  │
              │  │ b. 计算新尺寸    │  │  newW = baseW + 2*deltaX
              │  │                  │  │  newH = baseH + 2*deltaY
              │  ├─────────────────┤  │
              │  │ c. 合法性检查    │  │  0 < size ≤ 1000
              │  ├─────────────────┤  │
              │  │ d. 幂等性检测    │  │  已等于目标值 → 跳过
              │  ├─────────────────┤  │
              │  │ e. 构建新 tuple  │  │  buildNewShape()
              │  │    新 mask       │  │  buildNewMask()
              │  ├─────────────────┤  │
              │  │ f. 原子写入      │  │  await pcb_PrimitivePad
              │  │    modify(id, { │  │       .modify(id, {
              │  │      pad,       │  │         pad: newTuple,
              │  │      mask       │  │         solderMaskAndPasteMaskExpansion: newMask
              │  │    })           │  │       })
              │  └─────────────────┘  │
              └───────────┬───────────┘
                          │
                          ▼
              ┌─────────────────────┐
              │ ⑤ 结果处理           │
              │   全成功 → success   │
              │   部分成功 → error   │
              │   全失败 → error     │
              └─────────────────────┘
```

**防累积叠加设计：** 每次 apply 时，基准尺寸从 `state.backupData.pads[].originalShape` 重新计算，而非从 `pad.width` 取。确保无论 apply 多少次，结果都是 `原始尺寸 + 2×deltaX`，而非 `上次尺寸 + 2×deltaX`。

### 6.2 buildNewShape() — 尺寸 → API tuple

```javascript
// [index.html:1178-1192]
function buildNewShape(originalShape, newW, newH, unit) {
	const type = getShapeType(originalShape);
	const w = fromMm(newW, unit); // UI值 → API mil
	const h = fromMm(newH, unit);

	if (type === 'RECT')
		return ['RECT', w, h, originalShape[3] || 0]; // 保留圆角
	if (type === 'ELLIPSE' || type === 'OVAL' || type === 'OBLONG')
		return [type, w, h];
	if (type === 'NGON')
		return ['NGON', fromMm(Math.max(newW, newH), unit), originalShape[2] || 6]; // 直径取大值，保留边数
	throw new Error(`不支持的焊盘形状: ${type}`);
}
```

**示例：**
```
输入: buildNewShape(["RECT", 118, 59, 4], 3.6, 2.1, "mm")
  → fromMm(3.6, "mm") = 3.6 × 39.37 = 141.7 mil
  → fromMm(2.1, "mm") = 2.1 × 39.37 = 82.7 mil
  → 输出: ["RECT", 141.7, 82.7, 4]
```

### 6.3 buildNewMask() — maskExpansion → API mask 对象

```javascript
// [index.html:1206-1219]
function buildNewMask(originalMask, maskExpansion, unit) {
	const v = fromMm(maskExpansion, unit);

	if (!originalMask) {
		// 原始为 null (遵循规则) → 创建新对象，只设置 topSolderMask
		return { topSolderMask: v };
	}

	// 原始为对象 → 浅拷贝原始值，覆盖 topSolderMask
	const base = {};
	for (const key in originalMask) {
		if (Object.prototype.hasOwnProperty.call(originalMask, key))
			base[key] = originalMask[key];
	}
	base.topSolderMask = v;
	return base;
}
```

**示例：**
```
情况1: originalMask = null, maskExpansion = -0.3, unit = "mm"
  → fromMm(-0.3, "mm") = -11.8 mil
  → 输出: { topSolderMask: -11.8 }

情况2: originalMask = { topSolderMask: 10, bottomSolderMask: 15 }, maskExpansion = -0.3
  → fromMm(-0.3, "mm") = -11.8 mil
  → 输出: { topSolderMask: -11.8, bottomSolderMask: 15 }  // 保留 bottomSolderMask，覆盖 topSolderMask
```

### 6.4 核心写入 API：modify()

```javascript
// 这是整个插件的「唯一写入点」
await eda.pcb_PrimitivePad.modify(pad.primitiveIdStr, {
	pad: newShape, // tuple 如 ["RECT", 142, 83, 4]
	solderMaskAndPasteMaskExpansion: newMask // 对象 如 {topSolderMask: -11.8}
});
```

> **为什么选用 `modify()` 而非 `toAsync() → setState → done()` 链？**
>
> | 方式 | 原子性 | 并发安全 | 代码量 |
> |------|--------|---------|--------|
> | `modify()` | ✅ 单次 RPC 调用 | ✅ 自动处理 | 1 行 |
> | `toAsync()` 链 | ❌ 三步分离（切换→设值→提交） | ❌ 必须 await done() 否则并发冲突 | 4 行 |
>
> 早期版本使用 `toAsync()` 链，忘记 await done() 导致 20 个焊盘并发修改，画布状态被破坏（只改了 1 个）。切换到 `modify()` 是 v26.6.1 的核心改进。

---

## 7. 还原变换

```
                    用户点击「还原」
                         │
                         ▼
              ┌─────────────────────┐
              │ ① 前置检查           │
              │   - isProcessing?   │
              │   - backupData 存在? │
              │   - EDA 连接?        │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ ② 遍历备份数据       │
              │   对每个备份焊盘:     │
              │                     │
              │   await modify(id, {│
              │     pad: backup     │  ← 原始 shape tuple
              │       .originalShape│
              │     mask: backup    │  ← 原始 mask (或 null)
              │       .originalMask │
              │       || null       │
              │   })                │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ ③ 结果处理           │
              │   全部还原 → 清空备份 │
              │   部分失败 → 保留备份 │  ← 可再次尝试还原
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ ④ await             │
              │   fetchSelectedPads()│  ← 刷新列表显示原始值
              └─────────────────────┘
```

**mask 还原语义：**
- `bk.originalMask` 为 `null` → 传 `null` → API 恢复「遵循规则」模式
- `bk.originalMask` 为 `{topSolderMask: 10}` → 传对象 → API 恢复该自定义值

---

## 8. 单位换算链路

EasyEDA PCB API **始终以 mil 为单位**。画布显示单位是用户偏好，不影响 API 数据格式。

```
用户输入 (mm/mil)              API 存储 (mil)                UI 显示 (mm/mil)
─────────────────              ──────────────                ─────────────────

  deltaX=0.3  ──fromMm()──►  0.3 × 39.37 = 11.8 mil
  deltaY=0.3  ──fromMm()──►  0.3 × 39.37 = 11.8 mil
  mask=-0.3   ──fromMm()──► -0.3 × 39.37 = -11.8 mil

  ┌──────────────────────────────────────────────────────────┐
  │ API 读取: getState_Pad() → ["RECT", 118, 59, 4]         │
  │                           (单位: mil)                    │
  └──────────────────────────┬───────────────────────────────┘
                             │
                     toMm()  │  118/39.37 = 3.00mm
                             │   59/39.37 = 1.50mm
                             ▼
                        UI 显示: 3.00 × 1.50 mm
```

```javascript
// [index.html:1119-1129]
const MM_TO_MIL = 1 / 0.0254; // ≈ 39.37

function toMm(value, unit) {
	if (unit === 'mm')
		return value / MM_TO_MIL; // API mil → UI mm
	return value; // unit === 'mil' → 已经是目标单位，不需转换
}

function fromMm(value, unit) {
	if (unit === 'mm')
		return value * MM_TO_MIL; // UI mm → API mil
	return value; // unit === 'mil' → 已经是目标单位，不需转换
}
```

> **为什么条件是 `unit === 'mm'` 而非 `unit === 'mil'`？** 因为 API 始终返回 mil，所以只有当画布显示单位为 mm 时才需要转换。早期版本条件写反了（`unit === 'mil'` 时转换），导致 mm 画布下用户输入 0.3mm 被当作 0.3mil 写入，尺寸差了约 39 倍。

---

## 9. 完整数据流时序

以下是一次完整操作（选中 3 个焊盘 → 应用变换 → 还原）的数据流：

```
T0: 用户在 EasyEDA 中选中 3 个焊盘
    │
T1: 200ms 轮询触发 (ID 签名变化)
    │
    ├─ getAllSelectedPrimitives_PrimitiveId()
    │   → ["pad-1", "pad-2", "pad-3"]
    │
    ├─ 签名 "pad-1|pad-2|pad-3" ≠ 上次签名 → 触发 fetchSelectedPads()
    │
    ├─ getAllSelectedPrimitives()
    │   → [IPCB_PrimitivePad, IPCB_PrimitivePad, IPCB_PrimitivePad]
    │
    ├─ 遍历 × 3:
    │   ├─ getState_Pad()         → ["RECT", 118, 59, 4]  (mil)
    │   ├─ getState_SolderMask..  → null
    │   ├─ toMm(118, "mm")        → 3.00
    │   ├─ toMm(59, "mm")         → 1.50
    │   └─ push → state.padList
    │
    ├─ renderPadTable() → 表格显示 3 个焊盘
    ├─ setStatus('ready')
    └─ 状态: ready

T2: 用户调整 deltaX=0.5, 点击「应用」
    │
    ├─ fetchSelectedPads()  ← 重新读取确保最新
    │
    ├─ 创建备份:
    │   backupData.pads = [
    │     { id, primitiveIdStr, originalShape: ["RECT",118,59,4], originalMask: null },
    │     ...
    │   ]
    │
    ├─ 遍历 × 3:
    │   ├─ 从备份取基准: baseW=3.00, baseH=1.50
    │   ├─ newW = 3.00 + 2×0.5 = 4.00mm  →  fromMm → 157.5mil
    │   ├─ newH = 1.50 + 2×0.5 = 2.50mm  →  fromMm → 98.4mil
    │   ├─ buildNewShape → ["RECT", 157.5, 98.4, 4]
    │   ├─ buildNewMask(null, -0.5, "mm") → { topSolderMask: -19.7 }
    │   │
    │   └─ await pcb_PrimitivePad.modify("pad-1", {
    │        pad: ["RECT", 157.5, 98.4, 4],
    │        solderMaskAndPasteMaskExpansion: { topSolderMask: -19.7 }
    │      })
    │      → Promise<IPCB_PrimitivePad> ✅
    │
    ├─ 全部成功 → setStatus('success')
    └─ 状态: ready (backupData 保留)

T3: 用户点击「还原」
    │
    ├─ 遍历备份 × 3:
    │   └─ await pcb_PrimitivePad.modify("pad-1", {
    │        pad: ["RECT", 118, 59, 4],
    │        solderMaskAndPasteMaskExpansion: null
    │      })
    │      → Promise<IPCB_PrimitivePad> ✅
    │
    ├─ 全部成功 → backupData = null
    ├─ fetchSelectedPads() → 刷新列表显示 3.00×1.50
    └─ 状态: ready
```

---

## 10. 关键设计决策

| 决策 | 选型 | 原因 |
|------|------|------|
| 轮询策略 | 200ms + ID 签名比较 | 轻量，不阻塞 UI，精确检测选中变化 |
| 完整读取时机 | 仅应用时重新读取 | 每 200ms 调用 20+ 次 getState_Pad 是不必要的开销 |
| 备份创建时机 | 首次 apply 时 | 保证备份的是「变换前的状态」，避免误备份中间态 |
| 基准尺寸来源 | backup.originalShape | 防止重复 apply 累积叠加 |
| API 写入方式 | `modify()` 原子 API | 替代 toAsync/setState/done 三步链，消除并发竞争 |
| mask null 处理 | 保留 null，不转 {} | `null` = 遵循规则，`{}` = 自定义模式，语义完全不同 |
| 部分失败策略 | 继续执行，汇总报告 | 不因一个焊盘失败而中止全部操作 |
| 复杂多边形处理 | 自动跳过 + 用户提示 | POLYGON/COMPLEX_POLYGON 不支持简单缩放，静默跳过并提示数量 |
| 封装焊盘获取 | 6 级优先级链 | 兼容不同 API 版本和封装对象的结构差异 |
| 幂等性检测 | 尺寸公差 < 0.001mm | 避免对已处于目标状态的焊盘进行无意义的 modify 调用 |

---

## 附录：关键 API 速查

| API | 签名 | 说明 |
|-----|------|------|
| `pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId()` | `→ Promise<Array<string>>` | 获取选中图元 ID 列表 |
| `pcb_SelectControl.getAllSelectedPrimitives()` | `→ Promise<Array<IPCB_Primitive>>` | 获取选中图元对象列表 |
| `IPCB_PrimitivePad.getState_Pad()` | `→ TPCB_PrimitivePadShape | undefined` | 获取焊盘形状 tuple |
| `IPCB_PrimitivePad.getState_SolderMaskAndPasteMaskExpansion()` | `→ object \| null` | 获取阻焊/助焊扩展 |
| `PCB_PrimitivePad.modify(primitiveId, property)` | `→ Promise<IPCB_PrimitivePad \| undefined>` | 原子修改焊盘 |
| `IPCB_PrimitiveComponent.getAllPins()` | `→ Promise<Array<IPCB_PrimitiveComponentPad>>` | 获取封装内所有焊盘 |

> 完整 API 参考: `.claude/skills/easyeda-api-skill/references/`
