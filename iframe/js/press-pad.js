/**
 * FPC Workshop — Press-PAD Transform Module
 * 焊盘选择、变换、还原、表格渲染
 */
window.FPC = window.FPC || {};

(function () {
	'use strict';

	// 引用常用对象
	const state = FPC.state;
	const SM = FPC.StateMachine;
	const $ = FPC.$;

	// ========== Module-level state ==========
	let padLabelIndex = null; // primitiveId -> displayLabel
	let syncTimeout = null;

	// ========== EDA Helpers ==========
	FPC.getComponentPadObjects = async function (eda, componentObj) {
		let componentPads = [];
		try {
			if (typeof componentObj.getAllPins === 'function') {
				componentPads = await componentObj.getAllPins();
			}
			else if (typeof componentObj.getState_Pads === 'function') {
				componentPads = componentObj.getState_Pads();
			}
			else if (eda && eda.pcb_PrimitiveComponent && typeof eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId === 'function') {
				const componentId = componentObj.primitiveId || componentObj.id || componentObj.uuid;
				if (componentId) {
					const componentApi = eda.pcb_PrimitiveComponent;
					componentPads = await componentApi.getAllPinsByPrimitiveId(componentId);
				}
			}
			else if (typeof componentObj.getComponentPads === 'function') {
				componentPads = componentObj.getComponentPads();
			}
			else if (componentObj.componentPads) {
				componentPads = componentObj.componentPads;
			}
			else if (componentObj.pads) {
				componentPads = componentObj.pads;
			}
		}
		catch (e) {
			componentPads = [];
		}

		if (!componentPads)
			return [];
		if (Array.isArray(componentPads))
			return componentPads;
		if (typeof componentPads.length === 'number') {
			const arr = [];
			for (let i = 0; i < componentPads.length; i++) arr.push(componentPads[i]);
			return arr;
		}
		if (typeof componentPads === 'object') {
			const keys = Object.keys(componentPads);
			const out = [];
			for (let k = 0; k < keys.length; k++) out.push(componentPads[keys[k]]);
			return out;
		}
		return [];
	};

	FPC.buildPadLabelIndex = async function (eda) {
		if (padLabelIndex)
			return padLabelIndex;
		const index = {};
		try {
			const componentApi = eda.pcb_PrimitiveComponent;
			if (!componentApi || typeof componentApi.getAll !== 'function') {
				return index;
			}
			const allComps = await componentApi.getAll();
			if (!allComps || !allComps.length)
				return index;
			for (let ci = 0; ci < allComps.length; ci++) {
				const comp = allComps[ci];
				let designator = null;
				try {
					designator = typeof comp.getState_Designator === 'function' ? comp.getState_Designator() : null;
				}
				catch (e) { /* ignore */ }
				let pins = [];
				try {
					pins = typeof comp.getAllPins === 'function' ? await comp.getAllPins() : [];
				}
				catch (e) { /* ignore */ }
				if (!pins || !pins.length)
					continue;
				for (let pi = 0; pi < pins.length; pi++) {
					const pin = pins[pi];
					let pid = pin.primitiveId || pin.id;
					if (!pid) {
						try { pid = typeof pin.getState_PrimitiveId === 'function' ? pin.getState_PrimitiveId() : null; }
						catch (e) {}
					}
					if (!pid)
						continue;
					let pnum = pin.padNumber;
					if (pnum === undefined || pnum === null) {
						try { pnum = typeof pin.getState_PadNumber === 'function' ? pin.getState_PadNumber() : null; }
						catch (e) {}
					}
					index[String(pid)] = designator ? (`${designator}-${pnum || '?'}`) : String(pid);
				}
			}
		}
		catch (e) {
			console.error('[FPC] buildPadLabelIndex:', e);
		}
		// 兜底：通过 getAllPrimitiveId 获取游离焊盘（不在任何封装中的独立焊盘）
		try {
			const padApi = eda.pcb_PrimitivePad;
			if (padApi && typeof padApi.getAllPrimitiveId === 'function') {
				const allPadIds = await padApi.getAllPrimitiveId();
				if (allPadIds && allPadIds.length > 0) {
					for (let ai = 0; ai < allPadIds.length; ai++) {
						const fpid = String(allPadIds[ai]);
						if (!index[fpid]) {
							// 游离焊盘：取后 6 位作为短标识
							index[fpid] = `#${fpid.slice(-6)}`;
						}
					}
				}
			}
		}
		catch (e) {
			console.error('[FPC] getAllPrimitiveId fallback:', e);
		}
		padLabelIndex = index;
		return index;
	};

	// ========== Core: Fetch & Render ==========
	FPC.fetchSelectedPads = async function () {
		const eda = FPC.getEda();
		if (!eda || !eda.pcb_SelectControl) {
			FPC.clearPadList();
			return;
		}
		let primitives;
		try {
			primitives = await eda.pcb_SelectControl.getAllSelectedPrimitives();
		}
		catch (e) {
			console.error('Failed to get selected primitives:', e);
			FPC.clearPadList();
			FPC.setStatus('error', `读取选中对象失败: ${e.message || e}`);
			return;
		}
		if (!primitives) {
			FPC.clearPadList();
			return;
		}
		let arr = [];
		if (Array.isArray(primitives)) {
			arr = primitives;
		}
		else if (typeof primitives.length === 'number') {
			for (let i = 0; i < primitives.length; i++) {
				arr.push(primitives[i]);
			}
		}
		else {
			const keys = Object.keys(primitives);
			for (let k = 0; k < keys.length; k++) {
				arr.push(primitives[keys[k]]);
			}
		}
		const labelIndex = await FPC.buildPadLabelIndex(eda);
		const unit = FPC.getCanvasUnit();
		const pads = [];
		let skippedComplexCount = 0;

		for (let j = 0; j < arr.length; j++) {
			const obj = arr[j];
			if (!obj)
				continue;

			// 情况 A: 直接选中的焊盘（通过 API 特征检测）
			if (typeof obj.setState_Pad === 'function') {
				// 跳过复杂多边形
				let padShapeType = '';
				try {
					var rawShape = typeof obj.getState_Pad === 'function' ? obj.getState_Pad() : obj.shape;
					if (Array.isArray(rawShape))
						padShapeType = rawShape[0];
					else if (obj.padShape)
						padShapeType = obj.padShape;
				}
				catch (e) {}
				if (padShapeType === 'POLYGON' || padShapeType === 'POLYLINE_COMPLEX_POLYGON') {
					skippedComplexCount++;
					continue;
				}

				const st = FPC.readPadState(obj);
				if (!st) {
					// 无法读取焊盘数据，静默跳过（可能是非焊盘图元）
					continue;
				}
				const w = FPC.toMm(FPC.getShapeWidth(st.shape), unit);
				const h = FPC.toMm(FPC.getShapeHeight(st.shape), unit);
				const m = FPC.getMaskValue(st.mask, unit);
				const type = FPC.inferPadType(obj, w, h);

				const padX = FPC.toMm(obj.x || 0, unit);
				const padY = FPC.toMm(obj.y || 0, unit);

				// 从组件焊盘索引中查找显示标签
				const pid = String(obj.primitiveId || obj.id || (`Pad-${j}`));
				let displayLabel = labelIndex[pid] || pid;

				// 游离焊盘：显示 形状 @(x, y)
				if (!displayLabel || !displayLabel.includes('-')) {
					var rawShape = (st.shape && Array.isArray(st.shape) && st.shape[0]) || type || '?';
					var SHAPE_CN = { RECT: '矩形', ELLIPSE: '椭圆', OVAL: '长圆', OBLONG: '长圆', NGON: '多边形' };
					const shapeName = SHAPE_CN[rawShape] || rawShape;
					displayLabel = `${shapeName} @(${padX.toFixed(1)}, ${padY.toFixed(1)})`;
				}

				pads.push({
					id: String(obj.primitiveId || obj.id || obj.uuid || (`Pad-${j}`)),
					type,
					width: w,
					height: h,
					originalWidth: w,
					originalHeight: h,
					originalMask: st.mask,
					x: padX,
					y: padY,
					edaObj: obj,
					edaShape: st.shape,
					edaMask: st.mask,
					primitiveIdStr: String(obj.primitiveId || obj.id || (`Pad-${j}`)),
					unit: 'mm',
					designator: displayLabel !== pid ? displayLabel : null,
					padNumber: null,
					displayLabel,
				});
			}

			// 情况 B: 选中的封装
			else {
				const componentPads = await FPC.getComponentPadObjects(eda, obj);
				if (componentPads && componentPads.length > 0) {
					for (let cp = 0; cp < componentPads.length; cp++) {
						const cpObj = componentPads[cp];
						if (!cpObj)
							continue;
						if (typeof cpObj.setState_Pad !== 'function')
							continue;

						// 跳过复杂多边形
						let cpShapeType = '';
						try {
							var cpRawShape = typeof cpObj.getState_Pad === 'function' ? cpObj.getState_Pad() : cpObj.shape;
							if (Array.isArray(cpRawShape))
								cpShapeType = cpRawShape[0];
							else if (cpObj.padShape)
								cpShapeType = cpObj.padShape;
						}
						catch (e) {}
						if (cpShapeType === 'POLYGON' || cpShapeType === 'POLYLINE_COMPLEX_POLYGON') {
							skippedComplexCount++;
							continue;
						}

						const cpSt = FPC.readPadState(cpObj);
						if (!cpSt) {
							// 无法读取焊盘数据，静默跳过
							continue;
						}
						const cpW = FPC.toMm(FPC.getShapeWidth(cpSt.shape), unit);
						const cpH = FPC.toMm(FPC.getShapeHeight(cpSt.shape), unit);
						const cpM = FPC.getMaskValue(cpSt.mask, unit);
						const cpType = FPC.inferPadType(cpObj, cpW, cpH);
						const cpPadX = FPC.toMm(cpObj.x || 0, unit);
						const cpPadY = FPC.toMm(cpObj.y || 0, unit);
						// 从组件焊盘索引中查找显示标签
						const cpPid = String(cpObj.primitiveId || cpObj.id || (`CPad-${j}-${cp}`));
						let cpDisplayLabel = labelIndex[cpPid] || cpPid;

						// 游离焊盘兜底（极端情况：组件位号为空时也会走这里）
						if (!cpDisplayLabel || !cpDisplayLabel.includes('-')) {
							var cpRawShape = (cpSt.shape && Array.isArray(cpSt.shape) && cpSt.shape[0]) || cpType || '?';
							var SHAPE_CN = { RECT: '矩形', ELLIPSE: '椭圆', OVAL: '长圆', OBLONG: '长圆', NGON: '多边形' };
							const cpShapeName = SHAPE_CN[cpRawShape] || cpRawShape;
							cpDisplayLabel = `${cpShapeName} @(${cpPadX.toFixed(1)}, ${cpPadY.toFixed(1)})`;
						}

						pads.push({
							id: String(cpObj.primitiveId || cpObj.id || cpObj.uuid || (`CPad-${j}-${cp}`)),
							type: cpType,
							width: cpW,
							height: cpH,
							originalWidth: cpW,
							originalHeight: cpH,
							originalMask: cpSt.mask,
							x: cpPadX,
							y: cpPadY,
							edaObj: cpObj,
							edaShape: cpSt.shape,
							edaMask: cpSt.mask,
							primitiveIdStr: String(cpObj.primitiveId || cpObj.id || (`Pad-${j}`)),
							unit: 'mm',
							designator: cpDisplayLabel !== cpPid ? cpDisplayLabel : null,
							padNumber: null,
							displayLabel: cpDisplayLabel,
						});
					}
				}
			}
			// 其他类型静默跳过
		}

		state.padList = pads;
		state.selectedIds = new Set(pads.map((p) => { return p.id; }));
		FPC.renderPadTable();
		FPC.updatePadCount();
		FPC.updateButtons();

		if (pads.length > 0) {
			SM.transition('ready');
			let statusMsg = '就绪';
			if (skippedComplexCount > 0) {
				statusMsg += `（跳过 ${skippedComplexCount} 个复杂多边形）`;
			}
			FPC.setStatus('ready', statusMsg);
			FPC.setBottomStatus('ready', '就绪');
		}
		else {
			FPC.setStatus('ready', '就绪 — 请在画布中选中焊盘');
			FPC.setBottomStatus('idle', '就绪');
		}
	};

	FPC.clearPadList = function () {
		padLabelIndex = null;
		state.padList = [];
		state.selectedIds.clear();
		state.lastSelectedSignature = '';
		FPC.renderPadTable();
		FPC.updatePadCount();
		FPC.updateButtons();
		FPC.setStatus('ready', '就绪 — 请在画布中选中焊盘');
		FPC.setBottomStatus('idle', '就绪');
	};

	FPC.renderPadTable = function () {
		FPC.$padTableBody.innerHTML = state.padList.map((pad) => {
			const sel = state.selectedIds.has(pad.id);
			const dimStr = pad.type === 'ELLIPSE'
				? `Ø${pad.width.toFixed(2)}mm`
				: `${pad.width.toFixed(2)}×${pad.height.toFixed(2)}mm`;
			return (
				`<tr class="${sel ? 'selected-row' : ''}" data-pad-id="${pad.id}">`
				+ `<td><input type="checkbox" class="pad-checkbox" ${sel ? 'checked' : ''} data-pad-id="${pad.id}" /></td>`
				+ `<td title="${pad.id}">${pad.displayLabel || pad.id}</td>`
				+ `<td><span class="pad-type-badge">${({ RECT: '矩形', ELLIPSE: '椭圆', OVAL: '长圆', OBLONG: '长圆', NGON: '多边形' })[pad.type]}</span></td>`
				+ `<td>${dimStr}</td>`
				+ `</tr>`
			);
		}).join('');

		FPC.$padTableBody.querySelectorAll('.pad-checkbox').forEach((cb) => {
			cb.addEventListener('change', function () {
				const pid = this.getAttribute('data-pad-id');
				if (this.checked)
					state.selectedIds.add(pid);
				else state.selectedIds.delete(pid);
				FPC.updatePadCount();
				FPC.updateButtons();
				FPC.renderPadTable();
			});
		});

		FPC.$padTableBody.querySelectorAll('tr').forEach((row) => {
			row.addEventListener('click', function (e) {
				if (e.target.tagName === 'INPUT')
					return;
				const pid = this.getAttribute('data-pad-id');
				const cb = this.querySelector('.pad-checkbox');
				cb.checked = !cb.checked;
				if (cb.checked)
					state.selectedIds.add(pid);
				else state.selectedIds.delete(pid);
				FPC.updatePadCount();
				FPC.updateButtons();
				FPC.renderPadTable();
			});
		});
	};

	FPC.updatePadCount = function () {
		FPC.$padCount.textContent = state.selectedIds.size;
	};

	FPC.updatePadCountDisplay = function (count) {
		FPC.$padCount.textContent = count;
	};

	FPC.updateButtonsForCount = function (count) {
		FPC.$applyBtn.disabled = count === 0 || state.isProcessing;
	};

	FPC.updateButtons = function () {
		const count = state.selectedIds.size;
		FPC.$applyBtn.disabled = count === 0 || state.isProcessing;
		const hasModified = state.modifiedPads && Object.keys(state.modifiedPads).length > 0;
		FPC.$restoreBtn.disabled = !hasModified || state.isProcessing;
	};

	FPC.setStatus = function (level, message) {
		FPC.$statusDot.className = `status-dot ${level}`;
		FPC.$statusText.className = `status-text ${level}`;
		FPC.$statusText.textContent = message;
	};

	FPC.setBottomStatus = function (level, message) {
		if (!FPC.$bottomStatusDot || !FPC.$bottomStatusText)
			return;
		FPC.$bottomStatusDot.className = `status-bar-dot ${level}`;
		FPC.$bottomStatusText.textContent = message;
	};

	FPC.showProgress = function (current, total) {
		if (total <= 1)
			return;
		FPC.$progressContainer.style.display = 'block';
		FPC.$progressCurrent.textContent = current;
		FPC.$progressTotal.textContent = total;
		FPC.$progressBar.style.width = `${current / total * 100}%`;
	};

	FPC.hideProgress = function () {
		FPC.$progressContainer.style.display = 'none';
		FPC.$progressBar.style.width = '0%';
	};

	// ========== Core: Apply & Restore ==========
	FPC.applyTransform = async function () {
		if (state.isProcessing)
			return;
		if (!SM.transition('processing'))
			return;

		state.isProcessing = true;
		FPC.updateButtons();
		FPC.setStatus('processing', '正在处理...');
		FPC.setBottomStatus('busy', '处理中...');

		try {
			const eda = FPC.getEda();
			if (!eda || !eda.pcb_PrimitivePad) {
				SM.transition('error');
				FPC.setStatus('error', '✗ EDA 未连接或 API 不可用');
				FPC.setBottomStatus('idle', '就绪');
				return;
			}

			// 读取完整数据
			await FPC.fetchSelectedPads();
			const padsToProcess = state.padList;

			if (padsToProcess.length === 0) {
				SM.transition('error');
				FPC.setStatus('error', '✗ 未检测到可变换的焊盘');
				FPC.setBottomStatus('idle', '就绪');
				return;
			}

			const unit = FPC.getCanvasUnit();

			// 累积式备份：首次修改的焊盘才备份原始状态
			if (!state.modifiedPads)
				state.modifiedPads = {};
			let newlyModified = 0;
			for (let mi = 0; mi < padsToProcess.length; mi++) {
				const mp = padsToProcess[mi];
				const key = mp.primitiveIdStr || String(mp.id);
				if (!state.modifiedPads[key]) {
					state.modifiedPads[key] = {
						id: mp.id,
						primitiveIdStr: mp.primitiveIdStr,
						edaObj: mp.edaObj,
						originalShape: JSON.parse(JSON.stringify(mp.edaShape)),
						originalMask: mp.edaMask ? JSON.parse(JSON.stringify(mp.edaMask)) : null,
						designator: mp.designator,
						padNumber: mp.padNumber,
						displayLabel: mp.displayLabel,
						x: mp.x,
						y: mp.y,
					};
					newlyModified++;
				}
			}

			let successCount = 0;
			let lastError = '';

			for (let i = 0; i < padsToProcess.length; i++) {
				FPC.showProgress(i + 1, padsToProcess.length);
				const pad = padsToProcess[i];
				try {
					// 使用备份中的原始值防止累积叠加
					let baseW = pad.originalWidth;
					let baseH = pad.originalHeight;
					if (state.modifiedPads && Object.keys(state.modifiedPads).length > 0) {
						const padKey = pad.primitiveIdStr || String(pad.id);
						const bk = state.modifiedPads[padKey];
						if (bk && bk.originalShape) {
							baseW = FPC.toMm(FPC.getShapeWidth(bk.originalShape), unit);
							baseH = FPC.toMm(FPC.getShapeHeight(bk.originalShape), unit);
						}
					}
					const newW = baseW + 2 * state.deltaX;
					const newH = baseH + 2 * state.deltaY;

					if (newW <= 0 || newH <= 0 || newW > 1000 || newH > 1000) {
						lastError = '焊盘尺寸超出合法范围';
						continue;
					}

					// 幂等性检测
					if (Math.abs(newW - pad.width) < 0.001 && Math.abs(newH - pad.height) < 0.001) {
						successCount++;
						continue;
					}

					const newShape = FPC.buildNewShape(pad.edaShape, newW, newH, unit);
					const newMask = FPC.buildNewMask(pad.edaMask, state.maskExpansion, unit);

					// NaN 最终门禁
					if (!newShape || !newMask) {
						lastError = `参数构建失败: 焊盘 ${pad.id}`;
						continue;
					}
					let hasNaN = false;
					if (Array.isArray(newShape)) {
						for (let si = 1; si < newShape.length; si++) {
							if (typeof newShape[si] === 'number' && isNaN(newShape[si])) { hasNaN = true; break; }
						}
					}
					if (!hasNaN && newMask && typeof newMask === 'object') {
						for (const mk in newMask) {
							if (typeof newMask[mk] === 'number' && isNaN(newMask[mk])) { hasNaN = true; break; }
						}
					}
					if (hasNaN) {
						console.error('applyTransform: NaN detected before modify', { padId: pad.id, newShape, newMask });
						lastError = `NaN 值: 焊盘 ${pad.id}`;
						continue;
					}

					// 使用 toAsync() 全量传参，避免 modify() 引擎自动推导导致属性错乱
					let maskChanged = false;
					if (!pad.edaMask && state.maskExpansion !== 0) {
						maskChanged = true; // null → 自定义值
					}
					else if (pad.edaMask && typeof pad.edaMask === 'object') {
						const oldTopMask = pad.edaMask.topSolderMask || 0;
						const newTopMask = FPC.fromMm(state.maskExpansion, unit);
						if (Math.abs(oldTopMask - newTopMask) > 0.001)
							maskChanged = true;
					}

					const edaObj = pad.edaObj;
					const hole = edaObj.getState_Hole();
					const layer = edaObj.getState_Layer();
					const rot = edaObj.getState_Rotation();
					const x = edaObj.getState_X();
					const y = edaObj.getState_Y();
					const padNum = edaObj.getState_PadNumber();
					const padTypeVal = edaObj.getState_PadType();
					const net = edaObj.getState_Net();
					const metal = edaObj.getState_Metallization();
					const lock = edaObj.getState_PrimitiveLock();

					edaObj.toAsync();
					edaObj.setState_Pad(newShape);
					if (hole !== null && hole !== undefined) {
						edaObj.setState_Hole(hole);
					}
					edaObj.setState_Layer(layer);
					edaObj.setState_Rotation(rot);
					edaObj.setState_X(x);
					edaObj.setState_Y(y);
					edaObj.setState_PadNumber(padNum);
					edaObj.setState_PadType(padTypeVal);
					edaObj.setState_Net(net);
					edaObj.setState_Metallization(metal);
					edaObj.setState_PrimitiveLock(lock);
					if (maskChanged) {
						edaObj.setState_SolderMaskAndPasteMaskExpansion(newMask);
					}
					await edaObj.done();

					// toAsync + done 成功后返回 true（done 无返回值）
					const result = true;

					if (result) {
						pad.width = newW;
						pad.height = newH;
						successCount++;
					}
					else {
						lastError = `修改焊盘 ${pad.id} 失败（API 返回 undefined）`;
					}
				}
				catch (e) {
					lastError = (e && e.message) ? e.message : String(e);
					console.error('Transform failed for pad', pad.id, e);
				}
			}
			FPC.hideProgress();

			if (successCount === padsToProcess.length) {
				SM.transition('success');
				FPC.setStatus('success', `✓ 已应用 ${successCount} 个焊盘`);
				FPC.setBottomStatus('ready', '✓ 已应用变换');
			}
			else if (successCount > 0) {
				SM.transition('error');
				FPC.setStatus('error', `部分成功: ${successCount}/${padsToProcess.length} 个焊盘`);
				FPC.setBottomStatus('ready', '部分成功');
			}
			else {
				SM.transition('error');
				FPC.setStatus('error', `✗ 操作失败: ${lastError || '未知错误'}`);
				FPC.setBottomStatus('idle', '失败');
			}

			FPC.renderPadTable();
		}
		finally {
			SM.transition('success'); // processing → success（安全兜底）
			SM.transition('ready'); // success → ready
			state.isProcessing = false;
			FPC.updateButtons();
		}
	};

	/**
	 * 从 V3 设计规则中读取阻焊默认扩展值（单位：PCB 系统单位 1mil）
	 * 当焊盘原始状态为 "遵循规则"（originalMask === null）时，无法通过 API 直接还原 null
	 * 此函数读取 SOLDER RULE 的 padTopExpan/padBotExpan 作为功能等价替代值
	 */
	FPC.restoreTransform = async function () {
		const modifiedPadsEntries = state.modifiedPads && Object.keys(state.modifiedPads);
		if (state.isProcessing || !modifiedPadsEntries || modifiedPadsEntries.length === 0)
			return;
		if (!SM.transition('processing'))
			return;

		state.isProcessing = true;
		FPC.updateButtons();
		FPC.setStatus('processing', '正在还原...');
		FPC.setBottomStatus('busy', '还原中...');

		try {
			const eda = FPC.getEda();
			if (!eda || !eda.pcb_PrimitivePad) {
				SM.transition('error');
				FPC.setStatus('error', '✗ EDA 未连接或 API 不可用');
				FPC.setBottomStatus('idle', '就绪');
				return;
			}

			const backupKeys = Object.keys(state.modifiedPads);
			let successCount = 0;
			let skippedCount = 0;
			let lastError = '';

			for (let i = 0; i < backupKeys.length; i++) {
				const bk = state.modifiedPads[backupKeys[i]];
				try {
					// 使用 toAsync() 全量传参还原，避免 modify() 引擎自动推导导致属性错乱
					const edaObj = bk.edaObj;
					if (!edaObj) { skippedCount++; continue; }

					const hole = edaObj.getState_Hole();
					const layer = edaObj.getState_Layer();
					const rot = edaObj.getState_Rotation();
					const x = edaObj.getState_X();
					const y = edaObj.getState_Y();
					const padNum = edaObj.getState_PadNumber();
					const padTypeVal = edaObj.getState_PadType();
					const net = edaObj.getState_Net();
					const metal = edaObj.getState_Metallization();
					const lock = edaObj.getState_PrimitiveLock();

					edaObj.toAsync();
					edaObj.setState_Pad(bk.originalShape);
					if (hole !== null && hole !== undefined) {
						edaObj.setState_Hole(hole);
					}
					edaObj.setState_Layer(layer);
					edaObj.setState_Rotation(rot);
					edaObj.setState_X(x);
					edaObj.setState_Y(y);
					edaObj.setState_PadNumber(padNum);
					edaObj.setState_PadType(padTypeVal);
					edaObj.setState_Net(net);
					edaObj.setState_Metallization(metal);
					edaObj.setState_PrimitiveLock(lock);
					if (bk.originalMask && typeof bk.originalMask === 'object') {
						edaObj.setState_SolderMaskAndPasteMaskExpansion(bk.originalMask);
					}
					await edaObj.done();
					successCount++;
				}
				catch (e) {
					lastError = (e && e.message) ? e.message : String(e);
					console.error('Restore failed for pad', bk.id, e);
					skippedCount++;
				}
			}

			if (successCount === backupKeys.length) {
				state.modifiedPads = {};
			}
			try {
				await FPC.fetchSelectedPads();
				SM.transition('ready');
				FPC.setStatus('ready', `已还原 ${successCount} 个焊盘${skippedCount > 0 ? `（跳过 ${skippedCount} 个）` : ''}`);
				FPC.setBottomStatus('ready', '✓ 已还原');
			}
			catch (e) {
				FPC.setStatus('ready', `已还原 ${successCount} 个焊盘，但刷新列表失败`);
				FPC.setBottomStatus('ready', '✓ 已还原');
			}
		}
		finally {
			SM.transition('success'); // processing → success（安全兜底）
			SM.transition('ready'); // success → ready
			state.isProcessing = false;
			FPC.updateButtons();
		}
	};

	// ========== Input Handlers ==========
	FPC.syncDeltaY = function () {
		if (state.isLocked) {
			FPC.$deltaYInput.value = FPC.$deltaXInput.value;
			state.deltaY = Number.parseFloat(FPC.$deltaXInput.value) || 0;
			FPC.renderPadTable();
		}
	};

	FPC.handleDeltaXChange = function () {
		state.deltaX = Number.parseFloat(FPC.$deltaXInput.value) || 0;
		FPC.syncDeltaY();
		clearTimeout(syncTimeout);
		syncTimeout = setTimeout(() => { FPC.renderPadTable(); }, 200);
	};

	FPC.handleDeltaYChange = function () {
		state.deltaY = Number.parseFloat(FPC.$deltaYInput.value) || 0;
		clearTimeout(syncTimeout);
		syncTimeout = setTimeout(() => { FPC.renderPadTable(); }, 200);
	};

	FPC.handleMaskChange = function () {
		state.maskExpansion = Number.parseFloat(FPC.$maskExpansionInput.value) || 0;
	};

	FPC.toggleLock = function () {
		state.isLocked = !state.isLocked;
		if (state.isLocked) {
			FPC.$lockBtn.classList.add('locked');
			FPC.$lockHint.textContent = '';
			FPC.$deltaYInput.disabled = true;
			FPC.$deltaYInput.value = FPC.$deltaXInput.value;
			state.deltaY = state.deltaX;
		}
		else {
			FPC.$lockBtn.classList.remove('locked');
			FPC.$lockHint.textContent = '';
			FPC.$deltaYInput.disabled = false;
		}
		FPC.renderPadTable();
	};

	// ========== Press-Pad Init ==========
	FPC.initPressPad = function () {
		// DOM references
		FPC.$themeToggle = $('#themeToggle');
		FPC.$deltaXInput = $('#deltaX');
		FPC.$deltaYInput = $('#deltaY');
		FPC.$maskExpansionInput = $('#maskExpansion');
		FPC.$lockBtn = $('#lockBtn');
		FPC.$applyBtn = $('#applyBtn');
		FPC.$restoreBtn = $('#restoreBtn');
		FPC.$padCount = $('#padCount');
		FPC.$padTableBody = $('#padTableBody');
		FPC.$statusDot = $('#statusDot');
		FPC.$statusText = $('#statusText');
		FPC.$bottomStatusDot = $('#bottomStatusDot');
		FPC.$bottomStatusText = $('#bottomStatusText');
		FPC.$progressContainer = $('#progressContainer');
		FPC.$progressCurrent = $('#progressCurrent');
		FPC.$progressTotal = $('#progressTotal');
		FPC.$progressBar = $('#progressBar');

		// DOM 引用也要用 FPC.$xxx
		FPC.$lockHint = $('#lockHint');
		FPC.$themeIcon = $('#themeIcon');

		// bind events
		if (FPC.$themeToggle) { FPC.$themeToggle.addEventListener('click', FPC.toggleTheme); }
		FPC.$lockBtn.addEventListener('click', FPC.toggleLock);
		FPC.$deltaXInput.addEventListener('input', FPC.handleDeltaXChange);
		FPC.$deltaYInput.addEventListener('input', FPC.handleDeltaYChange);
		FPC.$maskExpansionInput.addEventListener('input', FPC.handleMaskChange);
		FPC.$applyBtn.addEventListener('click', FPC.applyTransform);
		// FPC.$restoreBtn.addEventListener('click', FPC.restoreTransform);  // 已隐藏：组件焊盘无法通过 API 还原阻焊为"遵循规则"

		// init UI
		FPC.renderPadTable();
		FPC.updatePadCount();
		FPC.updateButtons();
		SM.reset();
		SM.transition('ready');
		FPC.setStatus('ready', '就绪 — 请在画布中选中焊盘');
		FPC.setBottomStatus('idle', '就绪');
		FPC.startPolling();
	};

	// ========== Auto-init ==========
	// core.js 先加载，press-pad.js 后加载 -> initCore 完成后初始化 press-pad
	FPC.initCore().then(() => {
		FPC.initPressPad();
	});
})();
