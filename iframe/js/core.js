/**
 * FPC Workshop — Core Module
 * 状态机、EDA 连接、轮询、主题、工具函数、Tab 切换
 */
window.FPC = window.FPC || {};

(function () {
	'use strict';

	// ========== Constants ==========
	FPC.MM_TO_MIL = 39.37007874;

	// ========== StateMachine ==========
	FPC.StateMachine = {
		_state: 'idle',
		_transitions: {
			idle: ['ready'],
			ready: ['processing'],
			processing: ['success', 'error'],
			success: ['ready', 'processing'],
			error: ['ready', 'processing'],
		},
		get state() { return this._state; },
		transition(newState) {
			if (!this._transitions[this._state] || !this._transitions[this._state].includes(newState)) {
				console.warn(`StateMachine: invalid transition ${this._state} -> ${newState}`);
				return false;
			}
			this._state = newState;
			return true;
		},
		reset() { this._state = 'idle'; },
	};

	// ========== Global State ==========
	FPC.state = {
		padList: [],
		selectedIds: new Set(),
		modifiedPads: {},
		isLocked: true,
		isProcessing: false,
		deltaX: 0.3,
		deltaY: 0.3,
		maskExpansion: -0.3,
		edaConnected: false,
		pollTimer: null,
		lastSelectedSignature: '',
	};

	// ========== Utility Functions ==========
	FPC.$ = function (sel) { return document.querySelector(sel); };

	FPC.getEda = function () {
		if (typeof eda !== 'undefined')
			return eda;
		if (parent && parent.eda)
			return parent.eda;
		if (opener && opener.eda)
			return opener.eda;
		return null;
	};

	FPC.checkEdaConnection = function () {
		const eda = FPC.getEda();
		const connected = !!(eda && eda.pcb_SelectControl);
		FPC.state.edaConnected = connected;
		return connected;
	};

	FPC.getCanvasUnit = function () {
		// Default to mm: the EDA API currently returns values in mil,
		// and this extension works in mm. Other units can be added when
		// the API provides a canvas unit query method.
		return 'mm';
	};

	FPC.toMm = function (value, unit) {
		// API always returns mil. Convert to display unit.
		if (unit === 'mm')
			return value / FPC.MM_TO_MIL;
		return value;
	};

	FPC.fromMm = function (value, unit) {
		// Display value to API mil.
		if (unit === 'mm')
			return value * FPC.MM_TO_MIL;
		return value;
	};

	// ========== I/O Helpers ==========
	FPC.readPadState = function (edaObj) {
		let shape = null;
		let mask = null;
		try {
			if (typeof edaObj.getState_Pad === 'function') {
				shape = edaObj.getState_Pad();
			}
			else if (edaObj.shape) {
				shape = edaObj.shape;
			}
			else if (edaObj.size) {
				shape = edaObj.size;
			}
		}
		catch (e) {}

		if (!Array.isArray(shape) || shape.length < 2) {
			return null;
		}

		try {
			if (typeof edaObj.getState_SolderMaskAndPasteMaskExpansion === 'function') {
				mask = edaObj.getState_SolderMaskAndPasteMaskExpansion();
			}
			else if (edaObj.solderMaskExpansion !== undefined) {
				mask = edaObj.solderMaskExpansion;
			}
		}
		catch (e) {}

		return { shape, mask };
		// null 表示遵循规则，保留原始语义
	};

	FPC.getShapeType = function (shape) {
		return Array.isArray(shape) ? shape[0] : '';
	};

	FPC.getShapeWidth = function (shape) {
		const type = FPC.getShapeType(shape);
		if (type === 'NGON')
			return shape[1];
		if (type === 'POLYGON')
			return 0;
		return shape[1] || 0;
	};

	FPC.getShapeHeight = function (shape) {
		const type = FPC.getShapeType(shape);
		if (type === 'NGON')
			return shape[1];
		if (type === 'POLYGON')
			return 0;
		return shape[2] || shape[1] || 0;
	};

	FPC.buildNewShape = function (originalShape, newW, newH, unit) {
		// NaN 门禁
		if (isNaN(newW) || isNaN(newH) || newW <= 0 || newH <= 0) {
			console.error('buildNewShape: invalid dimensions', { newW, newH });
			return null;
		}
		const type = FPC.getShapeType(originalShape);
		const w = FPC.fromMm(newW, unit);
		const h = FPC.fromMm(newH, unit);
		// 转换后 NaN 门禁
		if (isNaN(w) || isNaN(h)) {
			console.error('buildNewShape: conversion produced NaN', { newW, newH, unit, w, h });
			return null;
		}
		if (type === 'RECT') {
			return ['RECT', w, h, originalShape[3] || 0];
		}
		if (type === 'ELLIPSE' || type === 'OVAL' || type === 'OBLONG') {
			return [type, w, h];
		}
		if (type === 'NGON') {
			return ['NGON', FPC.fromMm(Math.max(newW, newH), unit), originalShape[2] || 6];
		}
		throw new Error(`不支持的焊盘形状: ${type}`);
	};

	FPC.getMaskValue = function (mask, unit) {
		if (!mask)
			return 0; // null/undefined = 0
		if (typeof mask === 'number')
			return FPC.toMm(mask, unit);
		if (mask && typeof mask === 'object') {
			let v = mask.topSolderMask;
			if (v === undefined)
				v = mask.bottomSolderMask;
			if (v === undefined)
				v = 0;
			return FPC.toMm(v, unit);
		}
		return 0;
	};

	FPC.buildNewMask = function (originalMask, maskExpansion, unit) {
		// NaN 门禁
		if (isNaN(maskExpansion)) {
			console.error('buildNewMask: maskExpansion is NaN', maskExpansion);
			return null;
		}
		const v = FPC.fromMm(maskExpansion, unit);
		if (isNaN(v)) {
			console.error('buildNewMask: conversion produced NaN', { maskExpansion, unit, v });
			return null;
		}
		if (!originalMask) {
			return { topSolderMask: v };
		}
		const base = {};
		if (originalMask && typeof originalMask === 'object') {
			for (const key in originalMask) {
				if (Object.prototype.hasOwnProperty.call(originalMask, key)) {
					const val = originalMask[key];
					if (!isNaN(val))
						base[key] = val;
				}
			}
		}
		base.topSolderMask = v;
		return base;
	};

	FPC.inferPadType = function (edaObj, width, height) {
		try {
			let st = null;
			if (typeof edaObj.getState_Pad === 'function')
				st = edaObj.getState_Pad();
			else if (edaObj.shape)
				st = edaObj.shape;
			if (Array.isArray(st))
				return st[0];
		}
		catch (e) {}
		if (Math.abs(width - height) < 0.001)
			return 'ELLIPSE';
		return 'RECT';
	};

	FPC.normalizeSelectionIds = function (ids) {
		let list = [];
		if (Array.isArray(ids)) {
			list = ids;
		}
		else if (ids && typeof ids.length === 'number') {
			for (let i = 0; i < ids.length; i++) list.push(ids[i]);
		}
		else if (ids && typeof ids === 'object') {
			const keys = Object.keys(ids);
			for (let k = 0; k < keys.length; k++) list.push(ids[keys[k]]);
		}
		return list.map((id) => { return String(id); }).sort();
	};

	FPC.getSelectionSignature = function (ids) {
		return FPC.normalizeSelectionIds(ids).join('|');
	};

	// ========== Theme ==========
	FPC.applyTheme = function (theme) {
		document.documentElement.setAttribute('data-theme', theme);
		if (FPC.$themeIcon) { FPC.$themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙'; }
		try { localStorage.setItem('fpc-workshop-theme', theme); }
		catch (e) {}
	};

	FPC.toggleTheme = function () {
		const current = document.documentElement.getAttribute('data-theme');
		FPC.applyTheme(current === 'dark' ? 'light' : 'dark');
	};

	FPC.loadTheme = function () {
		try {
			const saved = localStorage.getItem('fpc-workshop-theme');
			if (saved === 'light' || saved === 'dark')
				FPC.applyTheme(saved);
		}
		catch (e) {}
	};

	FPC.syncEditorTheme = async function () {
		const eda = FPC.getEda();
		if (eda && eda.sys_Window && typeof eda.sys_Window.getCurrentTheme === 'function') {
			try {
				const result = await eda.sys_Window.getCurrentTheme();
				if (result === 'dark' || result === 'light') {
					FPC.applyTheme(result);
					return;
				}
			}
			catch (e) {
				console.warn('syncEditorTheme: Failed to get theme from editor, using local cache', e);
			}
		}
		// Fallback: read from localStorage
		FPC.loadTheme();
	};

	// ========== Polling ==========
	FPC.startPolling = function () {
		if (FPC.state.pollTimer)
			return;
		FPC.state.pollTimer = setInterval(async () => {
			try {
				const eda = FPC.getEda();
				if (!eda || !eda.pcb_SelectControl) {
					if (FPC.state.padList.length > 0)
						FPC.clearPadList();
					return;
				}
				const selectControl = eda.pcb_SelectControl;
				const ids = await selectControl.getAllSelectedPrimitives_PrimitiveId();
				const normalizedIds = FPC.normalizeSelectionIds(ids);
				const signature = normalizedIds.join('|');
				if (signature !== FPC.state.lastSelectedSignature) {
					FPC.state.lastSelectedSignature = signature;
					if (normalizedIds.length > 0) {
						await FPC.fetchSelectedPads();
					}
					else {
						FPC.clearPadList();
					}
				}
			}
			catch (e) {
				// Polling errors are silent
			}
		}, 200);
	};

	FPC.stopPolling = function () {
		if (FPC.state.pollTimer) {
			clearInterval(FPC.state.pollTimer);
			FPC.state.pollTimer = null;
		}
	};

	// ========== TabSwitcher ==========
	FPC.TabSwitcher = {
		currentTab: 'press-pad',
		init() {
			const self = this;
			const buttons = document.querySelectorAll('.tab-btn');
			for (let i = 0; i < buttons.length; i++) {
				buttons[i].addEventListener('click', function () {
					self.switchTo(this.getAttribute('data-tab'));
				});
			}
		},
		switchTo(tabId) {
			if (tabId === this.currentTab)
				return;
			// update buttons
			const allBtns = document.querySelectorAll('.tab-btn');
			for (let i = 0; i < allBtns.length; i++) allBtns[i].classList.remove('active');
			const targetBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
			if (targetBtn)
				targetBtn.classList.add('active');
			// switch panels
			const allPanels = document.querySelectorAll('.tab-panel');
			for (let j = 0; j < allPanels.length; j++) allPanels[j].classList.remove('active');
			const targetPanel = document.getElementById(`tab-${tabId}`);
			if (targetPanel)
				targetPanel.classList.add('active');
			// polling lifecycle
			FPC.stopPolling();
			if (FPC.PiCalculator && FPC.PiCalculator.stopPolling)
				FPC.PiCalculator.stopPolling();
			if (FPC.TraceCurrentCalc && FPC.TraceCurrentCalc.stopPolling)
				FPC.TraceCurrentCalc.stopPolling();
			if (tabId === 'press-pad') { FPC.startPolling(); }
			else if (tabId === 'pi-reinforce') { FPC.PiCalculator.startPolling(); }
			else if (tabId === 'trace-current') { FPC.TraceCurrentCalc.startPolling(); }
			this.currentTab = tabId;
		},
	};

	// ========== Initialization ==========
	FPC.initCore = async function () {
		await FPC.syncEditorTheme();
		FPC.checkEdaConnection();
		FPC.TabSwitcher.init();
	};

	// ========== Lifecycle & Export ==========
	window.addEventListener('beforeunload', () => {
		FPC.state.modifiedPads = {};
		FPC.stopPolling();
	});

	window.__fpcWorkshop = { state: FPC.state, getEda: FPC.getEda, StateMachine: FPC.StateMachine };
})();
