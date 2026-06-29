/**
 * FPC Workshop — PI Stiffener Thickness Calculator
 * 金手指 PI 补强厚度计算器 + 2D 截面可视化
 *
 * 参考: https://www.jlc.com/newOrder/#/calcGoldfingerPIThickness
 *
 * 分层结构（自顶向下）:
 *   L1: PI 补强（计算目标）
 *   L2: 覆盖膜（黄黑 / 白 / 透明）
 *   L3: 铜箔（有铜 / 无铜）
 *   L4: 粘接胶（仅透明 FPC）
 *   L5: PET 基材
 *   L6: 粘接胶（仅透明 FPC）
 *   L7: 铜箔（底层）
 *
 * 公式: PI = 总厚度 - (覆盖膜 + 铜箔 + 粘接胶 + 基材 + 粘接胶 + 铜箔)
 */
window.FPC = window.FPC || {};

(function () {
	'use strict';

	// ================================================================
	//  DATA MODELS
	// ================================================================

	/** FPC 板厚预设（双面 5 种 + 单面 4 种） */
	const BOARD_DATA = {
		double: [
			{ value: 0.11, label: '0.11mm', cover: 0.0275, coverWhite: 0.0405, copper: 0.012, substrate: 0.025 },
			{ value: 0.12, label: '0.12mm', cover: 0.0275, coverWhite: 0.0405, copper: 0.018, substrate: 0.025 },
			{ value: 0.20, label: '0.20mm', cover: 0.05, coverWhite: 0.068, copper: 0.035, substrate: 0.025 },
			{ value: 0.19, label: '0.19mm 超厚', cover: 0.05, coverWhite: 0.068, copper: 0.018, substrate: 0.050 },
			{ value: 0.24, label: '0.24mm 透明', cover: 0.05, coverWhite: 0.05, copper: 0.035, substrate: 0.036 },
		],
		single: [
			{ value: 0.07, label: '0.07mm', cover: 0.0275, coverWhite: 0.0405, copper: 0.018, substrate: 0.025 },
			{ value: 0.11, label: '0.11mm', cover: 0.05, coverWhite: 0.068, copper: 0.035, substrate: 0.025 },
			{ value: 0.12, label: '0.12mm 超厚', cover: 0.05, coverWhite: 0.068, copper: 0.018, substrate: 0.050 },
			{ value: 0.14, label: '0.14mm 透明', cover: 0.05, coverWhite: 0.05, copper: 0.035, substrate: 0.036 },
		],
	};

	/** 材质标准厚度集 */
	const MATERIALS = {
		pi: { name: 'PI', thicknesses: [0.1, 0.15, 0.20, 0.225, 0.25] },
		fr4: { name: 'FR4', thicknesses: [0.1, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.6] },
		steel: { name: 'Stainless Steel', thicknesses: [0.1, 0.2, 0.3] },
	};

	/** 材质说明 */
	const MATERIAL_INFO = {
		pi: 'PI 补强：柔韧性好，常用于金手指插拨产品，推荐使用。',
		fr4: 'FR4 补强：成本低但易掉粉屑，尽量少用。需 AD 胶热压贴合。',
		steel: '钢片补强：平整度好、不变形，适合芯片贴片。具弱磁性，霍尔元件产品慎用。',
	};

	/**
	 * 材质原始名 → 中文显示名映射
	 * EDA 写入 "PI" 后可能规范化为 "Polyimide"（聚酰亚胺），两者都要覆盖
	 */
	const MATERIAL_DISPLAY = {
		'PI': 'PI',
		'Polyimide': 'PI',
		'FR4': 'FR4',
		'Stainless Steel': '钢片',
	};

	/**
	 * 获取翻译文本（i18n 优先，硬编码回退）
	 * @param {string} key   - 翻译键
	 * @param {string} fallback - 硬编码回退值
	 * @returns {string}
	 */
	function __(key, fallback) {
		if (typeof eda !== 'undefined' && eda.sys_I18n && eda.sys_I18n.text) {
			try {
				const translated = eda.sys_I18n.text(key);
				if (translated && translated !== key)
					return translated;
			}
			catch (e) { /* 降级到 fallback */ }
		}
		return fallback || key;
	}

	/**
	 * 将材质原始名转为显示名（英文→中文）
	 * @param {string} raw - 文档中的原始材质名
	 * @returns {string}
	 */
	function displayMaterial(raw) {
		if (!raw)
			return 'FR4';
		// 先查硬编码映射
		if (MATERIAL_DISPLAY[raw])
			return MATERIAL_DISPLAY[raw];
		// 再查 i18n（key 格式: material + PascalCase）
		const key = `material${raw.replace(/[^a-z0-9]/gi, '')}`;
		return __(key, raw);
	}

	/**
	 * 获取图层显示名
	 * @param {number} layerId
	 * @returns {string}
	 */
	function displayLayer(layerId) {
		return layerId === 58 ? __('layerTop', '顶层') : (layerId === 59 ? __('layerBottom', '底层') : `L${layerId}`);
	}

	/** PI 标准厚度集（用于建议值匹配） */
	const STANDARD_PI = [0.1, 0.15, 0.20, 0.225, 0.25, 0.30, 0.35, 0.40];

	/** 建议值映射（空 = 自动计算：取 ≥ 理论值的最小标准 PI） */
	const SUGGEST_MAP = {};

	// ================================================================
	//  DOM REFERENCES
	// ================================================================

	const el = {};

	/** 7 层结构引用 */
	const layers = {};

	// ================================================================
	//  LAYER UTILITIES
	// ================================================================

	function isLayerActive(lid) {
		return layers[lid].toggle ? layers[lid].toggle.checked : true;
	}

	function setLayerActive(lid, active) {
		if (layers[lid].toggle) {
			layers[lid].toggle.checked = active;
		}
	}

	// ================================================================
	//  2D VISUALIZATION
	// ================================================================

	/**
	 * 按实际厚度等比计算每层像素高度并应用到 DOM
	 * pxScale = 1000: 0.2mm → 200px
	 * minH = 6: 保证薄层至少有 6px 可辨识
	 */
	function applyLayerHeights() {
		const pxScale = 1000;
		const minH = 6;
		let totalPx = 0;

		Object.keys(layers).forEach((id) => {
			const ly = layers[id];
			const active = isLayerActive(id);
			const realMm = Number.parseFloat(ly.el.dataset.thick) || 0;
			const hPx = active ? Math.max(minH, realMm * pxScale) : 0;

			ly.face.style.height = `${hPx}px`;
			ly.el.style.marginBottom = '0';
			ly.el.style.display = active ? 'block' : 'none';

			if (hPx < 22 && active) {
				ly.face.classList.add('pi-thin');
			}
			else {
				ly.face.classList.remove('pi-thin');
			}

			if (active)
				totalPx += hPx;
		});

		// 更新左侧总高度标注
		const totalEl = document.getElementById('piStackTotal');
		const totalLabel = document.getElementById('piTotalLabel');
		if (totalEl && totalLabel) {
			totalEl.style.height = `${totalPx}px`;
			const totalMm = Number.parseFloat(el.totalThickness.value) || 0.3;
			totalLabel.textContent = `${totalMm.toFixed(2)}mm`;
		}
	}

	// ================================================================
	//  PARAMETER READING
	// ================================================================

	function getSelectedBoardData() {
		const boardType = el.typeDouble.checked ? 'double' : 'single';
		const checkedRadio = document.querySelector('input[name="piBoardThickness"]:checked');
		const boardValue = checkedRadio ? Number.parseFloat(checkedRadio.value) : BOARD_DATA[boardType][0].value;
		const boardData = BOARD_DATA[boardType].find((b) => { return b.value === boardValue; }) || BOARD_DATA[boardType][0];
		return { boardType, boardData };
	}

	function getParams() {
		const total = Number.parseFloat(el.totalThickness.value) || 0.3;
		const sel = getSelectedBoardData();
		const boardType = sel.boardType;
		const boardData = sel.boardData;
		const hasCopper = el.hasCopperYes.checked;
		const isTransparent = boardData.label.includes('透明');
		const isWhite = !isTransparent && el.coverWhite.checked;
		const board = boardData.value;
		const cover = isTransparent ? 0.05 : (isWhite ? boardData.coverWhite : boardData.cover);
		const copper = boardData.copper;
		const substrate = boardData.substrate;
		const isSingleSided = boardType === 'single';
		const adhesive = isTransparent ? 0.015 : 0;

		return {
			total,
			board,
			cover,
			copper,
			substrate,
			hasCopper,
			isWhite,
			isSingleSided,
			isTransparent,
			adhesive,
			boardData,
			boardType,
		};
	}

	// ================================================================
	//  CALCULATION ENGINE
	// ================================================================

	function calculate() {
		const p = getParams();

		const thick = {
			piL1: 0, // PI 补强（计算得出）
			piL2: p.cover, // 覆盖膜
			piL3: p.copper, // 铜箔
			piL4: p.adhesive, // 粘接胶
			piL5: p.substrate, // PET 基材
			piL6: p.adhesive, // 粘接胶
			piL7: p.copper, // 铜箔（底层）
		};

		// 各层激活状态
		const active = {};
		Object.keys(layers).forEach((id) => {
			active[id] = isLayerActive(id);
		});

		// FPC 本体厚度 = 所有激活层（不含 L1 PI 补强）之和
		let fpcThickness = 0;
		['piL2', 'piL3', 'piL4', 'piL5', 'piL6', 'piL7'].forEach((id) => {
			if (active[id])
				fpcThickness += thick[id];
		});

		// PI 理论厚度 = 总厚度 - FPC 本体厚度
		const piTheory = p.total - fpcThickness;
		thick.piL1 = piTheory;

		// 当前材质的标准厚度集
		const mat = document.querySelector('input[name="piMaterial"]:checked').value;
		const matData = MATERIALS[mat];

		// ── 公差推荐策略 ──
		// 正公差 +0.03mm：保证过盈配合（优先）
		// 负公差 -0.01mm
		// 优先级：刚好 > 正公差 > 负公差 > 无推荐
		const POS_TOL = 0.03;
		const NEG_TOL = 0.01;
		let exactMatch = null;
		let posMatch = null;
		let negMatch = null;

		matData.thicknesses.forEach((t) => {
			const diff = t - piTheory;
			if (Math.abs(diff) < 0.0005) {
				exactMatch = t;
			}
			else if (diff > 0 && diff <= POS_TOL) {
				if (posMatch === null || t < posMatch)
					posMatch = t;
			}
			else if (diff < 0 && diff >= -NEG_TOL) {
				if (negMatch === null || t > negMatch)
					negMatch = t;
			}
		});

		const suggest = exactMatch || posMatch || negMatch || null;
		const noSuitable = (suggest === null);

		return {
			params: p,
			thick,
			fpcThickness,
			piTheory,
			suggest,
			noSuitable,
			active,
			mat,
			matData,
		};
	}

	function buildFormula(r) {
		const parts = [];
		if (r.active.piL7)
			parts.push(r.thick.piL7.toFixed(3));
		if (r.active.piL6)
			parts.push(r.thick.piL6.toFixed(3));
		if (r.active.piL5)
			parts.push(r.thick.piL5.toFixed(3));
		if (r.active.piL4)
			parts.push(r.thick.piL4.toFixed(3));
		if (r.active.piL3)
			parts.push(r.thick.piL3.toFixed(3));
		if (r.active.piL2)
			parts.push(r.thick.piL2.toFixed(4));

		const fpcStr = parts.length > 0 ? parts.join(' + ') : '0';
		return `<span class="equals">PI = ${r.params.total.toFixed(2)}</span> - (${fpcStr}) = <span class="equals">${r.piTheory.toFixed(4)}</span> mm`;
	}

	// ================================================================
	//  UI RENDERING
	// ================================================================

	function renderInactiveList() {
		const r = calculate();
		const inactiveItems = [];

		Object.keys(layers).forEach((id) => {
			const ly = layers[id];
			const active = r.active[id];
			// 只显示用户可操作的层（非 disabled）被取消勾选
			if (!active && ly.toggle && !ly.toggle.disabled) {
				inactiveItems.push({ id, name: ly.name });
			}
		});

		if (inactiveItems.length === 0) {
			el.inactivePanel.classList.remove('pi-show');
			return;
		}

		el.inactivePanel.classList.add('pi-show');
		el.inactiveList.innerHTML = '';
		inactiveItems.forEach((item) => {
			const div = document.createElement('div');
			div.className = 'pi-inactive-item';
			div.textContent = item.name;
			div.addEventListener('click', () => {
				setLayerActive(item.id, true);
				update();
			});
			el.inactiveList.appendChild(div);
		});
	}

	function renderRuler() {
		const r = calculate();
		const matData = r.matData;
		const suggest = r.suggest;
		const max = matData.thicknesses[matData.thicknesses.length - 1];
		const noSuitable = r.noSuitable;

		el.rulerTrack.innerHTML = '';

		if (noSuitable) {
			const msg = document.createElement('div');
			msg.style.cssText = 'position:absolute;top:-28px;left:50%;transform:translateX(-50%);font-size:13px;font-weight:700;color:#fff;background:#ef4444;padding:2px 8px;border-radius:10px;white-space:nowrap;box-shadow:0 2px 6px rgba(239,68,68,0.3);z-index:10;';
			msg.textContent = '无推荐';
			el.rulerTrack.appendChild(msg);

			const trackBg = document.createElement('div');
			trackBg.style.cssText = 'position:relative;height:6px;background:#e2e8f0;border-radius:3px;';
			el.rulerTrack.appendChild(trackBg);

			matData.thicknesses.forEach((val, idx) => {
				const pct = (val / max) * 100;
				const tick = document.createElement('div');
				tick.className = `pi-ruler-tick${idx === 0 || idx === matData.thicknesses.length - 1 ? ' pi-major' : ''}`;
				tick.style.left = `${pct}%`;
				trackBg.appendChild(tick);

				const label = document.createElement('div');
				label.className = 'pi-ruler-tick-label';
				label.textContent = val.toFixed(3).replace(/\.?0+$/, '');
				label.style.left = `${pct}%`;
				// 奇偶交错避免密集刻度标签重叠（如 FR4 的 0.1/0.2）
				label.style.top = (idx % 2 === 0) ? '18px' : '30px';
				trackBg.appendChild(label);
			});

			// 计算需求厚度灰色气泡
			const theoryPct2 = Math.max(0, Math.min(100, (r.piTheory / max) * 100));
			const theoryBubble2 = document.createElement('div');
			theoryBubble2.className = 'pi-theory-bubble';
			theoryBubble2.textContent = `${r.piTheory.toFixed(4).replace(/\.?0+$/, '')}mm`;
			theoryBubble2.style.left = `${theoryPct2}%`;
			trackBg.appendChild(theoryBubble2);

			return;
		}

		// 填充条
		const fill = document.createElement('div');
		fill.className = 'pi-ruler-fill';
		fill.style.width = `${(suggest / max) * 100}%`;
		el.rulerTrack.appendChild(fill);

		// 刻度与标签
		matData.thicknesses.forEach((val, idx) => {
			const pct = (val / max) * 100;
			const isSuggest = Math.abs(val - suggest) < 0.001;

			const tick = document.createElement('div');
			tick.className = `pi-ruler-tick${idx === 0 || idx === matData.thicknesses.length - 1 ? ' pi-major' : ''}`;
			tick.style.left = `${pct}%`;
			el.rulerTrack.appendChild(tick);

			const label = document.createElement('div');
			label.className = `pi-ruler-tick-label${isSuggest ? ' pi-hidden' : ''}`;
			label.textContent = val.toFixed(3).replace(/\.?0+$/, '');
			label.style.left = `${pct}%`;
			// 奇偶交错避免密集刻度标签重叠（如 FR4 的 0.1/0.2）
			label.style.top = (idx % 2 === 0) ? '18px' : '30px';
			el.rulerTrack.appendChild(label);
		});

		// 当前建议指示器
		const suggestPct = (suggest / max) * 100;
		const ind = document.createElement('div');
		ind.className = 'pi-ruler-indicator';
		ind.style.left = `${suggestPct}%`;
		el.rulerTrack.appendChild(ind);

		const indLabel = document.createElement('div');
		indLabel.className = 'pi-ruler-indicator-label';
		indLabel.textContent = `${suggest.toFixed(3).replace(/\.?0+$/, '')}mm`;
		indLabel.style.left = `${suggestPct}%`;
		el.rulerTrack.appendChild(indLabel);

		// 计算需求厚度灰色气泡
		const theoryPct = Math.max(0, Math.min(100, (r.piTheory / max) * 100));
		const theoryBubble = document.createElement('div');
		theoryBubble.className = 'pi-theory-bubble';
		theoryBubble.textContent = `${r.piTheory.toFixed(4).replace(/\.?0+$/, '')}mm`;
		theoryBubble.style.left = `${theoryPct}%`;
		el.rulerTrack.appendChild(theoryBubble);
	}

	function update2D(r) {
		// 覆盖膜白色态
		layers.piL2.el.classList.toggle('pi-white', r.params.isWhite);

		Object.keys(layers).forEach((id) => {
			const ly = layers[id];
			const active = r.active[id];
			const val = active ? r.thick[id] : 0;
			const prec = (id === 'piL2' || id === 'piL1') ? 4 : 3;
			ly.text.textContent = val.toFixed(prec);
			ly.el.dataset.thick = val.toFixed(4);
		});

		applyLayerHeights();
	}

	function renderThicknessPicker() {
		const boardType = el.typeDouble.checked ? 'double' : 'single';
		const data = BOARD_DATA[boardType];
		const currentVal = getSelectedBoardData().boardData.value;

		el.thicknessPicker.innerHTML = '';
		data.forEach((item, idx) => {
			const div = document.createElement('div');
			div.className = 'pi-thickness-option';
			const inputId = `piThickness_${boardType}_${idx}`;
			const checked = (item.value === currentVal || idx === 0) ? 'checked' : '';
			div.innerHTML
				= `<input type="radio" name="piBoardThickness" id="${inputId}" value="${item.value}" ${checked}>`
					+ `<label class="pi-thickness-label" for="${inputId}">${item.label}</label>`;
			el.thicknessPicker.appendChild(div);
		});

		// 绑定事件
		const radios = el.thicknessPicker.querySelectorAll('input[name="piBoardThickness"]');
		for (let i = 0; i < radios.length; i++) {
			radios[i].addEventListener('change', () => {
				syncLayerState();
				updateCoverValues();
				update();
			});
		}
	}

	function updateCoverValues() {
		const bd = getSelectedBoardData().boardData;
		el.valYellow.textContent = bd.cover.toFixed(4);
		el.valWhite.textContent = bd.coverWhite.toFixed(4);
	}

	/**
	 * 根据板类型和透明态同步各层的 toggle 状态
	 *
	 * 规则:
	 * - L1 (PI): 始终存在，不可操作
	 * - L2 (覆盖膜): 双面默认激活，单面默认不激活，始终可操作
	 * - L3 (铜箔): 双面可操作（有铜→激活，无铜→不激活），单面无铜箔（不可操作）
	 * - L4, L6 (粘接胶): 仅透明 FPC 有，不可操作
	 * - L5, L7: 始终存在，不可操作
	 */
	function syncLayerState() {
		const p = getParams();

		// "背面有铜"行：单面隐藏
		if (p.isSingleSided) {
			el.copperRow.classList.add('pi-hidden');
		}
		else {
			el.copperRow.classList.remove('pi-hidden');
		}

		// L3: 铜箔（仅双面可操作）
		if (p.isSingleSided) {
			setLayerActive('piL3', false);
			layers.piL3.toggle.disabled = true;
		}
		else {
			layers.piL3.toggle.disabled = false;
			if (!p.hasCopper)
				setLayerActive('piL3', false);
			else setLayerActive('piL3', true);
		}

		// L4, L6: 粘接胶（仅透明 FPC）
		if (p.isTransparent) {
			if (p.isSingleSided) {
				setLayerActive('piL4', false);
				setLayerActive('piL6', true);
			}
			else {
				setLayerActive('piL4', true);
				setLayerActive('piL6', true);
			}
		}
		else {
			setLayerActive('piL4', false);
			setLayerActive('piL6', false);
		}
		layers.piL4.toggle.disabled = true;
		layers.piL6.toggle.disabled = true;

		// L5, L7: 始终存在，不可操作
		setLayerActive('piL5', true);
		setLayerActive('piL7', true);
		layers.piL5.toggle.disabled = true;
		layers.piL7.toggle.disabled = true;

		// L2: 覆盖膜（始终可操作）
		layers.piL2.toggle.disabled = false;
		if (p.isSingleSided) {
			setLayerActive('piL2', false);
		}
		else {
			setLayerActive('piL2', true);
		}

		// L1: PI 补强，始终存在，不可操作
		setLayerActive('piL1', true);
		layers.piL1.toggle.disabled = true;
	}

	// ================================================================
	//  MAIN UPDATE
	// ================================================================

	function update() {
		const r = calculate();

		if (r.noSuitable) {
			const thicknesses = r.matData.thicknesses;
			const minStd = thicknesses[0];
			const maxStd = thicknesses[thicknesses.length - 1];
			el.materialInfo.textContent = `精准厚度 ${r.piTheory.toFixed(4)
			}mm 不在公差范围（${minStd}–${maxStd}mm），无推荐标准厚度。请调整总厚度或板厚。`;
		}
		else {
			el.materialInfo.textContent = MATERIAL_INFO[r.mat];
		}

		update2D(r);
		renderInactiveList();
		renderRuler();

		// 覆盖膜 UI 切换
		if (r.params.isTransparent) {
			el.coverPicker.style.display = 'none';
			el.coverReadonly.style.display = 'flex';
			el.valTransparent.textContent = r.params.cover.toFixed(4);
		}
		else {
			el.coverPicker.style.display = 'flex';
			el.coverReadonly.style.display = 'none';
		}
	}

	// ================================================================
	//  EVENT BINDING
	// ================================================================

	function bindLayerEvents() {
		// hover 高亮 + dim 其他层
		Object.keys(layers).forEach((id) => {
			const ly = layers[id].el;
			ly.addEventListener('mouseenter', () => {
				ly.classList.add('pi-active');
				Object.keys(layers).forEach((jid) => {
					if (jid !== id)
						layers[jid].el.classList.add('pi-dim');
				});
			});
			ly.addEventListener('mouseleave', () => {
				ly.classList.remove('pi-active');
				Object.keys(layers).forEach((jid) => {
					layers[jid].el.classList.remove('pi-dim');
				});
			});
		});

		// toggle 变更 → 重新计算
		Object.keys(layers).forEach((id) => {
			const cb = layers[id].toggle;
			if (cb && !cb.disabled) {
				cb.addEventListener('change', () => {
					update();
				});
			}
		});
	}

	function bindEvents() {
		el.totalThickness.addEventListener('input', update);
		el.typeDouble.addEventListener('change', () => {
			renderThicknessPicker();
			syncLayerState();
			updateCoverValues();
			update();
		});
		el.typeSingle.addEventListener('change', () => {
			renderThicknessPicker();
			syncLayerState();
			updateCoverValues();
			update();
		});
		el.hasCopperYes.addEventListener('change', () => {
			syncLayerState();
			update();
		});
		el.hasCopperNo.addEventListener('change', () => {
			syncLayerState();
			update();
		});
		el.coverYellow.addEventListener('change', update);
		el.coverWhite.addEventListener('change', update);
		el.matPi.addEventListener('change', update);
		el.matFr4.addEventListener('change', update);
		el.matSteel.addEventListener('change', update);

		// "应用"按钮
		const applyBtn = document.getElementById('piApplyBtn');
		if (applyBtn) {
			applyBtn.addEventListener('click', () => {
				PiCalculator.applyToStiffener();
			});
		}
	}

	// ================================================================
	//  EDA INTEGRATION — 选择轮询
	// ================================================================

	/**
	 * 启动画布选择轮询（切换到 PI 补强 Tab 时调用）
	 * 每 500ms 检测一次画布选区是否包含补强板
	 */
	function startPolling() {
		if (typeof eda === 'undefined')
			return;
		PiCalculator.pollingTimer = setInterval(() => {
			PiCalculator.detectStiffener();
		}, 500);
	}

	/**
	 * 停止轮询（离开 PI 补强 Tab 时调用）
	 */
	function stopPolling() {
		if (PiCalculator.pollingTimer) {
			clearInterval(PiCalculator.pollingTimer);
			PiCalculator.pollingTimer = null;
		}
	}

	// ================================================================
	//  EDA INTEGRATION — 文档解析
	// ================================================================

	/**
	 * 解析文档源码中的 FPC_FILL 行
	 *
	 * 每行格式:
	 *   {"type":"FPC_FILL","id":"uuid","ticket":N}||{"partitionId":"","groupId":0,...,"layerId":58,"material":"FR4","thickness":0.2,"path":[[x,y],...]}|
	 *
	 * @param {string} sourceText - document source 原始文本
	 * @returns {Array<{id:string, layerId:number, material:string, thickness:number, path:Array}>}
	 */
	function parseFpcFills(sourceText) {
		const fills = [];
		if (!sourceText)
			return fills;

		const lines = sourceText.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line.includes('FPC_FILL'))
				continue;

			// 按 || 分割: [outerJSON, innerJSON|]
			const parts = line.split('||');
			if (parts.length < 2)
				continue;

			try {
				const outer = JSON.parse(parts[0]);
				// inner 以 | 结尾，去掉尾部
				let innerStr = parts[1];
				if (innerStr.charAt(innerStr.length - 1) === '|') {
					innerStr = innerStr.slice(0, -1);
				}
				const inner = JSON.parse(innerStr);

				fills.push({
					id: outer.id,
					ticket: outer.ticket,
					layerId: inner.layerId,
					material: inner.material || 'FR4',
					thickness: typeof inner.thickness === 'number' ? inner.thickness : 0.2,
					path: inner.path || [],
					lineIndex: i,
					rawLine: line,
				});
			}
			catch (e) {
				// 解析失败的行跳过（可能是其他格式）
			}
		}

		// 按层排序（顶层在前），层内按 ID 稳定排序
		// 材质和厚度会随应用操作变化，不作为排序依据
		fills.sort((a, b) => {
			if (a.layerId !== b.layerId)
				return a.layerId - b.layerId; // 58(顶层) < 59(底层)
			return (a.id < b.id) ? -1 : (a.id > b.id) ? 1 : 0;
		});

		return fills;
	}

	// ================================================================
	//  EDA INTEGRATION — 选择检测
	// ================================================================

	/**
	 * 检测画布选中的补强板
	 *
	 * 流程:
	 *   1. 获取文档源码 → 解析所有 FPC_FILL
	 *   2. 获取画布当前选中的图元 ID 列表
	 *   3. 匹配选中的 ID 与 FPC_FILL 的 id
	 *   4. 匹配成功 → 自动检测铜层内容 → 更新 UI
	 */
	async function detectStiffener() {
		if (typeof eda === 'undefined')
			return;

		// 锁定模式：applyToStiffener 写回后永久锁定，
		// 防止轮询用旧数据覆盖 parsedFills 或画布选中漂移
		if (PiCalculator._lockSelection)
			return;

		try {
			// 1. 解析文档中的 FPC_FILL
			const source = await eda.sys_FileManager.getDocumentSource();
			if (!source)
				return;

			const fills = parseFpcFills(source);
			const prevCount = (PiCalculator.parsedFills || []).length;
			PiCalculator.parsedFills = fills;

			// 补强列表变更时重新渲染选择器
			if (fills.length !== prevCount) {
				renderStiffenerTable(fills);
			}

			// 2. 获取画布选中
			const selectedIds = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();

			// 画布无选中 → 清空表格勾选
			if (!selectedIds || selectedIds.length === 0) {
				if (PiCalculator.selectedStiffeners.length > 0) {
					PiCalculator.selectedStiffeners = [];
					renderStiffenerTable(PiCalculator.parsedFills);
				}
				return;
			}

			// 3. 匹配所有画布选中的补强
			const matched = [];
			for (let i = 0; i < fills.length; i++) {
				if (selectedIds.includes(fills[i].id)) {
					matched.push(fills[i]);
				}
			}

			// 画布选中了非补强图元 → 不处理（保留当前表格勾选）
			if (matched.length === 0)
				return;

			// 避免重复处理：对比 ID 集合是否相同
			const currentIds = PiCalculator.selectedStiffeners.map((s) => { return s.id; }).sort().join(',');
			const newIds = matched.map((s) => { return s.id; }).sort().join(',');
			if (currentIds === newIds)
				return;

			// 4. 匹配成功：更新选中数组 + 重渲染
			PiCalculator.selectedStiffeners = matched;
			renderStiffenerTable(PiCalculator.parsedFills);

			// 铜层检测用第一个选中补强
			let hasCopper = false;
			if (typeof eda !== 'undefined') {
				hasCopper = await checkCopperInRegion(matched[0].path, matched[0].layerId);
			}
			if (hasCopper) { el.hasCopperYes.checked = true; }
			else { el.hasCopperNo.checked = true; }
			syncLayerState();
			update();
		}
		catch (err) {
			console.warn('[FPC-PI] detectStiffener error:', err);
		}
	}

	/**
	 * 更新补强选择器的显示（重渲染表格）
	 */
	function updateStiffenerDisplay() {
		renderStiffenerTable(PiCalculator.parsedFills);
	}

	// ================================================================
	//  EDA INTEGRATION — 铜层检测
	// ================================================================

	/**
	 * 检查补强板区域对应铜层是否有图元
	 *
	 * 层映射:
	 *   layerId 58 (TOP_STIFFENER)    → copper layer 1 (TOP_COPPER)
	 *   layerId 59 (BOTTOM_STIFFENER) → copper layer 2 (BOTTOM_COPPER)
	 *
	 * @param {Array<Array<number>>} path - FPC_FILL 的 path 数组 [[x,y], ...]
	 * @param {number} stiffenerLayerId - 补强所在的层 ID (58 或 59)
	 * @returns {Promise<boolean>} 是否有铜层图元
	 */
	async function checkCopperInRegion(path, stiffenerLayerId) {
		if (typeof eda === 'undefined')
			return false;
		if (!path || path.length === 0)
			return false;

		try {
			// 确定对应的铜层
			const copperLayer = stiffenerLayerId === 58 ? 1 : (stiffenerLayerId === 59 ? 2 : null);
			if (copperLayer === null)
				return false;

			// 计算 bounding box (path 中的坐标是 PCB mils)
			const xs = path.map((p) => { return p[0]; });
			const ys = path.map((p) => { return p[1]; });
			const minX = Math.min.apply(null, xs);
			const maxX = Math.max.apply(null, xs);
			const minY = Math.min.apply(null, ys);
			const maxY = Math.max.apply(null, ys);

			// 空间查询
			const primitives = await eda.pcb_Document.getPrimitivesInRegion(minX, maxX, maxY, minY);
			if (!primitives || primitives.length === 0)
				return false;

			// 过滤：只保留对应铜层上的图元
			for (let i = 0; i < primitives.length; i++) {
				try {
					const layer = primitives[i].getState_Layer();
					if (layer === copperLayer)
						return true;
				}
				catch (e) {
					// 某些 primitive 类型可能没有 getState_Layer()，跳过
				}
			}

			return false;
		}
		catch (err) {
			console.warn('[FPC-PI] checkCopperInRegion error:', err);
			return false;
		}
	}

	// ================================================================
	//  EDA INTEGRATION — 应用到补强
	// ================================================================

	/**
	 * 将当前计算的材质和厚度写入选中的补强板
	 *
	 * 修改文档源码中对应 FPC_FILL 行的 material 和 thickness 字段
	 */
	async function applyToStiffener() {
		if (typeof eda === 'undefined') {
			console.warn('[FPC-PI] EDA API not available — running in standalone mode');
			return;
		}

		const stiffeners = PiCalculator.selectedStiffeners;
		if (!stiffeners || stiffeners.length === 0) {
			console.warn('[FPC-PI] apply: no stiffener selected');
			try { eda.sys_Message.showToastMessage('请先在画布选中补强板'); }
			catch (e) {}
			return;
		}

		// 读取当前计算结果
		const r = calculate();
		const material = r.mat;
		const thickness = r.suggest;

		if (r.noSuitable) {
			try { eda.sys_Message.showToastMessage('当前无合适的标准厚度，请调整参数'); }
			catch (e) {}
			return;
		}

		try {
			// 提前锁定：防止 await 期间轮询定时器用旧数据覆盖 parsedFills
			PiCalculator._lockSelection = true;

			// 获取文档源码
			const source = await eda.sys_FileManager.getDocumentSource();
			if (!source) {
				try { eda.sys_Message.showToastMessage('无法获取文档数据'); }
				catch (e) {}
				return;
			}

			const lines = source.split('\n');

			// 遍历所有行找最大 ticket（只执行一次，批量递增）
			let maxTicket = 0;
			for (let j = 0; j < lines.length; j++) {
				const ticketMatch = lines[j].match(/"ticket"\s*:\s*(\d+)/);
				if (ticketMatch) {
					const t = Number.parseInt(ticketMatch[1]);
					if (t > maxTicket)
						maxTicket = t;
				}
			}

			let appliedCount = 0;

			// 遍历所有选中的补强，逐个修改
			for (var si = 0; si < stiffeners.length; si++) {
				const stiffener = stiffeners[si];
				console.warn(`[FPC-PI] apply: #${si + 1}/${stiffeners.length
				} material=${material} thickness=${thickness
				} stiffener.id=${stiffener.id
				} layerId=${stiffener.layerId} lineIndex=${stiffener.lineIndex}`);

				let targetIndex = stiffener.lineIndex;

				// 验证行索引仍然有效（文档可能已在外部修改）
				if (targetIndex < 0 || targetIndex >= lines.length) {
					console.warn(`[FPC-PI] apply: lineIndex ${targetIndex} stale, re-searching...`);
					targetIndex = -1;
					for (let i = 0; i < lines.length; i++) {
						if (lines[i].includes(`"id":"${stiffener.id}"`)) {
							targetIndex = i;
							break;
						}
					}
					if (targetIndex < 0) {
						console.warn(`[FPC-PI] apply: stiffener #${si + 1} not found in source, skipping`);
						continue;
					}
				}

				const line = lines[targetIndex];
				const parts = line.split('||');
				if (parts.length < 2) {
					console.warn(`[FPC-PI] apply: cannot split by ||, parts=${parts.length}`);
					continue;
				}

				// 解析并修改 inner JSON
				let innerStr = parts[1];
				if (innerStr.charAt(innerStr.length - 1) === '|') {
					innerStr = innerStr.slice(0, -1);
				}
				const inner = JSON.parse(innerStr);

				const oldMaterial = inner.material;
				const oldThickness = inner.thickness;
				console.warn(`[FPC-PI] apply: old material=${oldMaterial} thickness=${oldThickness}`);

				// 写入新值
				inner.material = MATERIALS[material].name; // "PI", "FR4", or "Stainless Steel"
				inner.thickness = thickness;

				// 递增 ticket（每行一个唯一 ticket）
				maxTicket++;
				const outerObj = JSON.parse(parts[0]);
				outerObj.ticket = maxTicket;

				// 重新序列化
				const newLine = `${JSON.stringify(outerObj)}||${JSON.stringify(inner)}|`;
				lines[targetIndex] = newLine;

				// 更新缓存
				stiffener.material = inner.material;
				stiffener.thickness = inner.thickness;
				appliedCount++;
			}

			if (appliedCount === 0) {
				try { eda.sys_Message.showToastMessage('未找到可应用的补强板'); }
				catch (e) {}
				return;
			}

			// 一次性写回文档
			const joined = lines.join('\n');
			console.warn(`[FPC-PI] apply: setDocumentSource with ${joined.length} chars, applied ${appliedCount}`);
			const ok = await eda.sys_FileManager.setDocumentSource(joined);

			if (!ok) {
				try { eda.sys_Message.showToastMessage('写入失败，请重试'); }
				catch (e) {}
				return;
			}

			// 重新解析文档获取 EDA 规范化后的最新数据
			// （写入 "PI" 后 EDA 可能规范化为 "Polyimide" 等）
			const freshSource = await eda.sys_FileManager.getDocumentSource();
			if (freshSource) {
				PiCalculator.parsedFills = parseFpcFills(freshSource);
			}

			// 从新鲜数据中重建选中数组（对象引用可能已变，按 ID 重新匹配）
			const keepIds = {};
			for (var si = 0; si < PiCalculator.selectedStiffeners.length; si++) {
				keepIds[PiCalculator.selectedStiffeners[si].id] = true;
			}
			PiCalculator.selectedStiffeners = PiCalculator.parsedFills.filter((f) => {
				return keepIds[f.id];
			});

			// 更新显示
			renderStiffenerTable(PiCalculator.parsedFills);

			// setDocumentSource 触发 EDA 重渲染（图元重建），画布选中会丢失
			// 从已刷新的 selectedStiffeners 中取 ID，重新同步到画布
			if (typeof eda !== 'undefined' && PiCalculator.selectedStiffeners.length > 0) {
				try {
					const selectIds = PiCalculator.selectedStiffeners.map((s) => { return s.id; });
					await eda.pcb_SelectControl.clearSelected();
					await eda.pcb_SelectControl.doSelectPrimitives(selectIds);
					console.warn(`[FPC-PI] apply: re-selected ${selectIds.length} stiffeners on canvas`);
				}
				catch (e) {
					console.warn('[FPC-PI] apply: canvas re-select failed', e);
				}
			}

			try {
				eda.sys_Message.showToastMessage(
					`已应用 ${appliedCount} 个补强: ${MATERIALS[material].name} ${thickness.toFixed(3)}mm`,
				);
			}
			catch (e) {}
		}
		catch (err) {
			console.error('[FPC-PI] applyToStiffener error:', err);
			try { eda.sys_Message.showToastMessage(`应用失败: ${err.message || '未知错误'}`); }
			catch (e) {}
		}
		finally {
			PiCalculator._lockSelection = false;
		}
	}

	// ================================================================
	//  EDA INTEGRATION — 选择器渲染
	// ================================================================

	/**
	 * 切换补强的选中状态（toggle）：
	 *   已在选中数组 → 移除
	 *   不在选中数组 → 添加
	 * 副作用：同步画布选中、重渲染表格、检测铜层
	 *
	 * @param {object} fill - 要切换的 FPC_FILL 对象
	 */
	async function selectStiffener(fill) {
		if (!fill)
			return;

		// 解除锁定：用户主动操作时恢复画布自动检测
		PiCalculator._lockSelection = false;

		// 查找 fill 是否已在选中数组
		let idx = -1;
		for (let i = 0; i < PiCalculator.selectedStiffeners.length; i++) {
			if (PiCalculator.selectedStiffeners[i].id === fill.id) {
				idx = i;
				break;
			}
		}

		// 1. Toggle：添加或移除
		if (idx >= 0) {
			PiCalculator.selectedStiffeners.splice(idx, 1);
		}
		else {
			PiCalculator.selectedStiffeners.push(fill);
		}

		// 2. 同步到画布（程序化选中/取消）
		if (typeof eda !== 'undefined') {
			try {
				const ids = PiCalculator.selectedStiffeners.map((s) => { return s.id; });
				await eda.pcb_SelectControl.clearSelected();
				if (ids.length > 0) {
					await eda.pcb_SelectControl.doSelectPrimitives(ids);
				}
			}
			catch (e) {
				console.warn('[FPC-PI] selectStiffener: canvas sync failed', e);
			}
		}

		// 3. 立即重渲染表格
		renderStiffenerTable(PiCalculator.parsedFills);

		// 4. 铜层检测用第一个选中补强
		if (PiCalculator.selectedStiffeners.length > 0) {
			const primary = PiCalculator.selectedStiffeners[0];
			let hasCopper = false;
			if (typeof eda !== 'undefined') {
				hasCopper = await checkCopperInRegion(primary.path, primary.layerId);
			}
			if (hasCopper) { el.hasCopperYes.checked = true; }
			else { el.hasCopperNo.checked = true; }
		}

		// 5. 同步层状态 + 重新计算 + 刷新示意图
		syncLayerState();
		update();
	}

	/**
	 * 渲染补强板表格（支持多选高亮）
	 * @param {Array} fills - parseFpcFills() 返回的补强数组
	 */
	function renderStiffenerTable(fills) {
		const tbody = el.stiffenerTableBody;
		const emptyEl = el.stiffenerEmpty;
		const countEl = el.stiffenerCount;
		const tableEl = el.stiffenerTable;

		if (!tbody)
			return;

		if (!fills || fills.length === 0) {
			tbody.innerHTML = '';
			if (tableEl)
				tableEl.style.display = 'none';
			if (emptyEl)
				emptyEl.style.display = '';
			if (countEl)
				countEl.textContent = '';
			return;
		}

		// 显示表格，隐藏占位文字
		if (tableEl)
			tableEl.style.display = '';
		if (emptyEl)
			emptyEl.style.display = 'none';

		tbody.innerHTML = '';

		// 构建选中 ID 查找表（O(1) 查找）
		const selectedIds = {};
		const stiffeners = PiCalculator.selectedStiffeners || [];
		for (let i = 0; i < stiffeners.length; i++) {
			selectedIds[stiffeners[i].id] = true;
		}

		fills.forEach((fill) => {
			const isSelected = !!selectedIds[fill.id];

			const tr = document.createElement('tr');
			if (isSelected) {
				tr.classList.add('selected-row');
			}

			// Checkbox 列
			const tdCheck = document.createElement('td');
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.className = 'pi-stiff-checkbox';
			cb.checked = isSelected;
			cb.addEventListener('change', async (e) => {
				e.stopPropagation();
				// toggle 模式：勾选/取消都走 selectStiffener
				await selectStiffener(fill);
			});
			tdCheck.appendChild(cb);
			tr.appendChild(tdCheck);

			// 层列
			const tdLayer = document.createElement('td');
			tdLayer.textContent = displayLayer(fill.layerId);
			tr.appendChild(tdLayer);

			// 材质列（中文显示）
			const tdMat = document.createElement('td');
			tdMat.textContent = displayMaterial(fill.material);
			tr.appendChild(tdMat);

			// 厚度列
			const tdThick = document.createElement('td');
			tdThick.textContent = typeof fill.thickness === 'number' ? fill.thickness.toFixed(3) : '0.200';
			tr.appendChild(tdThick);

			// 行点击（非 checkbox 区域）：同 toggle
			tr.addEventListener('click', (e) => {
				if (e.target.tagName === 'INPUT')
					return;
				selectStiffener(fill);
			});

			tbody.appendChild(tr);
		});

		// 更新计数显示
		if (countEl) {
			const fmt = __('stiffenerCount', '{0}/{1} 个');
			countEl.textContent = fmt.replace('{0}', stiffeners.length).replace('{1}', fills.length);
		}
	}

	// ================================================================
	//  MODULE EXPORT
	// ================================================================

	var PiCalculator = {
		// data
		BOARD_DATA,
		MATERIALS,

		// state
		selectedStiffeners: [],
		pollingTimer: null,
		parsedFills: [],

		// DOM — populated in init()
		el,
		layers,

		// public API
		init,
		update,
		calculate,
		getParams,
		buildFormula,

		// EDA integration
		startPolling,
		stopPolling,
		parseFpcFills,
		detectStiffener,
		checkCopperInRegion,
		applyToStiffener,
		selectStiffener,
		renderStiffenerTable,
	};

	/**
	 * Entry point — called by index.html inline script:
	 *   FPC.PiCalculator.init();
	 */
	function init() {
		// === Resolve DOM references ===
		el.totalThickness = document.getElementById('piTotalThickness');
		el.typeDouble = document.getElementById('piTypeDouble');
		el.typeSingle = document.getElementById('piTypeSingle');
		el.copperRow = document.getElementById('piCopperRow');
		el.hasCopperYes = document.getElementById('piHasCopperYes');
		el.hasCopperNo = document.getElementById('piHasCopperNo');
		el.coverYellow = document.getElementById('piCoverYellow');
		el.coverWhite = document.getElementById('piCoverWhite');
		el.thicknessPicker = document.getElementById('piThicknessPicker');
		el.valYellow = document.getElementById('piValYellow');
		el.valWhite = document.getElementById('piValWhite');
		el.valTransparent = document.getElementById('piValTransparent');
		el.coverPicker = document.getElementById('piCoverPicker');
		el.coverReadonly = document.getElementById('piCoverReadonly');
		el.matPi = document.getElementById('piMatPi');
		el.matFr4 = document.getElementById('piMatFr4');
		el.matSteel = document.getElementById('piMatSteel');
		el.rulerTrack = document.getElementById('piRulerTrack');
		el.materialInfo = document.getElementById('piMaterialInfo');
		el.inactivePanel = document.getElementById('piInactivePanel');
		el.inactiveList = document.getElementById('piInactiveList');
		el.stiffenerTable = document.getElementById('piStiffenerTable');
		el.stiffenerTableBody = document.getElementById('piStiffenerTableBody');
		el.stiffenerEmpty = document.getElementById('piStiffenerEmpty');
		el.stiffenerCount = document.getElementById('piStiffenerCount');

		// === Resolve 7-layer references ===
		[
			['piL1', 'piF1', 'piV1'],
			['piL2', 'piF2', 'piV2'],
			['piL3', 'piF3', 'piV3'],
			['piL4', 'piF4', 'piV4'],
			['piL5', 'piF5', 'piV5'],
			['piL6', 'piF6', 'piV6'],
			['piL7', 'piF7', 'piV7'],
		].forEach((tuple) => {
			const lid = tuple[0];
			const elNode = document.getElementById(lid);
			if (!elNode)
				return;
			layers[lid] = {
				el: elNode,
				face: document.getElementById(tuple[1]),
				val: document.getElementById(tuple[2]),
				toggle: elNode.querySelector('.pi-layer-toggle'),
				text: elNode.querySelector('.pi-val-text'),
				name: elNode.dataset.name,
			};
		});

		// === Initialize UI ===
		renderThicknessPicker();
		bindLayerEvents();
		bindEvents();
		syncLayerState();
		updateCoverValues();
		update();
	}

	FPC.PiCalculator = PiCalculator;
})();
