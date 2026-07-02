/**
 * FPC Workshop — Trace Current Calculator v4 (IPC-2221)
 * 验证模式 + I-W 折线图 + 画布集成
 */
window.FPC = window.FPC || {};

(function () {
	'use strict';

	const RHO = 0.0170; // 铜电阻率 Ω·mm²/m (25℃, 与嘉立创 1.7e-6 Ω·cm 一致)
	const K_EXTERNAL = 0.048; // IPC-2221 外层
	const K_INTERNAL = 0.024; // IPC-2221 内层

	// Chart layout constants (viewBox 0 0 400 300)
	const CHART = { PAD_L: 50, PAD_R: 10, PAD_T: 10, PAD_B: 30, W: 400, H: 300 };
	CHART.PLOT_W = CHART.W - CHART.PAD_L - CHART.PAD_R; // 340
	CHART.PLOT_H = CHART.H - CHART.PAD_T - CHART.PAD_B; // 260

	const TraceCurrentCalc = {
		// ---- State ----
		mode: 'manual', // 'manual' | 'verify'
		selectedTraceIds: [], // primitive IDs from canvas
		selectedNetName: '',
		selectedNetGroups: [], // [{ name, count, lenMm }] — 按网络分组
		selectedNetTotalLen: 0, // net total length (mm)
		selectedTraceLen: 0, // sum of selected trace lengths (mm)
		selectedAvgWidth: 0, // average width of selected traces (mm)
		_dirty: false, // suppress recalc during batch updates
		lockedParam: 'deltaT', // 'deltaT' | 'width'  — which result is the target (locked)

		// ---- DOM refs ----
		$chartSvg: null, $chartGrid: null, $isoCurve: null, $chartDot: null,
		$projX: null, $projY: null,
		$chartYLabel: null, $chartLabel2: null, $chartUnit2: null,
		$chartI: null, $chartW: null,
		$selDot: null, $selText: null,
		$copperSeg: null, $layerSeg: null,
		$copperCustomInput: null,
		$current: null, $length: null,
		$lengthAutoBadge: null,
		$widthSlider: null, $dtSlider: null,
		$width: null, $deltaT: null, $resistance: null, $voltageDrop: null, $powerLoss: null,
		$applyBtn: null,

		/* ================================================================
		   INIT
		   ================================================================ */
		init() {
			// Chart
			this.$chartSvg = document.getElementById('tcIwChart');
			this.$chartGrid = document.getElementById('tcChartGrid');
			this.$isoCurve = document.getElementById('tcIsoCurve');
			this.$chartDot = document.getElementById('tcChartDot');
			this.$projX = document.getElementById('tcProjX');
			this.$projY = document.getElementById('tcProjY');
			this.$chartI = document.getElementById('tcChartI');
			this.$chartW = document.getElementById('tcChartW');
			this.$chartYLabel = document.getElementById('tcChartYLabel');
			this.$chartLabel2 = document.getElementById('tcChartLabel2');
			this.$chartUnit2 = document.getElementById('tcChartUnit2');

			// Selection card
			this.$selDot = document.getElementById('tcSelDot');
			this.$selText = document.getElementById('tcSelText');

		// Segment controls
			this.$copperSeg = document.getElementById('tcCopperSeg');
			this.$layerSeg = document.getElementById('tcLayerSeg');
			this.$copperCustomInput = document.getElementById('tcCopperThicknessCustom');

			// Parameters
			this.$current = document.getElementById('tcCurrent');
			this.$length = document.getElementById('tcLength');
			this.$lengthAutoBadge = document.getElementById('tcLengthAutoBadge');

			// Result cards — W
			this.$width = document.getElementById('tcResultWidth');     // now <input>
			this.$widthSlider = document.getElementById('tcWidthSlider');

			// Result cards — ΔT (merged: target + result in one input)
			this.$deltaT = document.getElementById('tcResultDeltaT');   // now <input>
			this.$dtSlider = document.getElementById('tcTempRiseSlider');

			// Mini results
			this.$resistance = document.getElementById('tcResultResistance');
			this.$voltageDrop = document.getElementById('tcResultVoltageDrop');
			this.$powerLoss = document.getElementById('tcResultPowerLoss');

			// Lock buttons
			this.$lockW = document.getElementById('tcLockW');
			this.$lockDT = document.getElementById('tcLockDT');

			// Actions
			this.$applyBtn = document.getElementById('tcApplyBtn');

			this._bindEvents();
			this._updateLockUI();
			this._updateSelectionUI();
			this._recalculate();
		},

		/* ================================================================
		   EVENT BINDING
		   ================================================================ */
		_bindEvents() {
			const self = this;

			// Parameter inputs (I, L)
			[this.$current, this.$length].forEach((el) => {
				if (!el) return;
				el.addEventListener('input', () => { self._onCurrentChange(); });
				el.addEventListener('change', () => { self._onCurrentChange(); });
			});

			// Copper, layer, custom inputs
			if (this.$copperSeg) {
				this.$copperSeg.addEventListener('change', (e) => {
					if (!e.target.name || e.target.name !== 'tcCopperThickness') return;
					self._onCopperSegChange();
					self._onCurrentChange();
				});
			}
			if (this.$copperCustomInput) {
				this.$copperCustomInput.addEventListener('input', () => {
					self._autoSelectCopperCustom();
					self._onCurrentChange();
				});
				this.$copperCustomInput.addEventListener('change', () => { self._onCurrentChange(); });
			}

			if (this.$layerSeg) {
				this.$layerSeg.addEventListener('change', (e) => {
					if (!e.target.name || e.target.name !== 'tcLayer') return;
					self._onCurrentChange();
				});
			}

			// Chart readout inputs
			if (this.$chartI) {
				this.$chartI.addEventListener('input', () => { self._onChartInputChange('I'); });
				this.$chartI.addEventListener('change', () => { self._onChartInputChange('I'); });
			}
			if (this.$chartW) {
				this.$chartW.addEventListener('input', () => { self._onChartInputChange('W'); });
				this.$chartW.addEventListener('change', () => { self._onChartInputChange('W'); });
			}

			// W card — slider + number input
			if (this.$widthSlider) {
				this.$widthSlider.addEventListener('input', () => { self._onWSliderChange(); });
			}
			if (this.$width) {
				this.$width.addEventListener('input', () => { self._onWInputChange(); });
				this.$width.addEventListener('change', () => { self._onWInputChange(); });
			}

			// ΔT card — slider + number input
			if (this.$dtSlider) {
				this.$dtSlider.addEventListener('input', () => { self._onDTSliderChange(); });
			}
			if (this.$deltaT) {
				this.$deltaT.addEventListener('input', () => { self._onDTInputChange(); });
				this.$deltaT.addEventListener('change', () => { self._onDTInputChange(); });
			}

			// Lock buttons — either toggles the lock to the other parameter
			if (this.$lockW) {
				this.$lockW.addEventListener('click', () => { self._onLockToggle(); });
			}
			if (this.$lockDT) {
				this.$lockDT.addEventListener('click', () => { self._onLockToggle(); });
			}

			// Apply button
			if (this.$applyBtn) {
				this.$applyBtn.addEventListener('click', () => { self._onApply(); });
			}

			// Chart dot drag
			this._bindChartDrag();
		},

		_setSegValue(container, value) {
			const radio = container.querySelector(`input[value="${value}"]`);
			if (radio) radio.checked = true;
		},

		/* ---- Chart Dot Drag ---- */
		_bindChartDrag() {
			const self = this;
			const dot = this.$chartDot;
			const svg = this.$chartSvg;
			if (!dot || !svg) return;

			let dragging = false;

			function svgToChart(svgX, svgY) {
				const svgRect = svg.getBoundingClientRect();
				const scaleX = CHART.W / svgRect.width;
				const scaleY = CHART.H / svgRect.height;
				const vbx = svgX * scaleX;
				const vby = svgY * scaleY;
				const iMax = self._getChartIMax();
				const I = Math.max(0.01, ((vbx - CHART.PAD_L) / CHART.PLOT_W) * iMax);
				const wMax = self._getChartWMax();
				const W = Math.max(0.01, ((CHART.H - CHART.PAD_B - vby) / CHART.PLOT_H) * wMax);
				return { I, W };
			}

			function onStart(e) {
				e.preventDefault();
				dragging = true;
				dot.classList.add('dragging');
			}

			function onMove(e) {
				if (!dragging) return;
				e.preventDefault();
				const svgRect = svg.getBoundingClientRect();
				const svgX = (e.touches ? e.touches[0].clientX : e.clientX) - svgRect.left;
				const svgY = (e.touches ? e.touches[0].clientY : e.clientY) - svgRect.top;
				const { I } = svgToChart(svgX, svgY);

				const tUm = self._getCopperThickness();
				const k = self._getK();
				if (tUm > 0) {
					self._setDirty(true);
					self.$current.value = I.toFixed(2);
					self.$chartI.value = I.toFixed(2);

					if (self.lockedParam === 'width') {
						// W 锁定 → 计算 ΔT，钳位到 500°C（超出 PCB 物理极限）
						const wMm = Number.parseFloat(self.$width.value) || 0;
						const dT = Math.min(500, self._calcTempRiseFromWidth(I, wMm, tUm, k));
						if (dT > 0) {
							self.$deltaT.value = dT.toFixed(1);
							self.$dtSlider.value = dT;
							if (document.activeElement !== self.$chartW) {
								self.$chartW.value = dT.toFixed(1);
							}
						}
					} else {
						// ΔT 锁定 → 计算 W
						const dT = self._getAllowedDT();
						if (dT > 0) {
							const wCurve = self._calcWidthFromTempRise(I, dT, tUm, k);
							if (wCurve > 0) self._setWidthValue(wCurve);
						}
					}
					self._setDirty(false);
					self._recalculate();
				}
			}

			function onEnd() {
				if (!dragging) return;
				dragging = false;
				dot.classList.remove('dragging');
			}

			dot.addEventListener('mousedown', onStart);
			dot.addEventListener('touchstart', onStart, { passive: false });
			document.addEventListener('mousemove', onMove);
			document.addEventListener('touchmove', onMove, { passive: false });
			document.addEventListener('mouseup', onEnd);
			document.addEventListener('touchend', onEnd);
		},

		/* ================================================================
		   EVENT HANDLERS
		   ================================================================ */
		_onCurrentChange() {
			/* I / L / 铜厚 / 层变 → 锁定参数跟随，被动参数重新算 */
			if (this._dirty) return;
			const I = Number.parseFloat(this.$current.value) || 0;
			if (this.$chartI && document.activeElement !== this.$chartI) {
				this.$chartI.value = I > 0 ? I.toFixed(2) : '1';
			}
			if (this.lockedParam === 'deltaT') this._forwardCalcW();
			this._recalculate();
		},

		/* ---- W Card Handlers ---- */
		_onWSliderChange() {
			if (this._dirty) return;
			// 操作 W → 自动锁 W
			if (this.lockedParam !== 'width') {
				this.lockedParam = 'width';
				this._updateLockUI();
			}
			const wMm = Number.parseFloat(this.$widthSlider.value) || 0;
			this._setDirty(true);
			this.$width.value = wMm.toFixed(3);
			if (this.$chartW && document.activeElement !== this.$chartW) {
				this.$chartW.value = wMm.toFixed(3);
			}
			this._setDirty(false);
			this._recalculate();
		},

		_onWInputChange() {
			if (this._dirty) return;
			if (this.lockedParam !== 'width') {
				this.lockedParam = 'width';
				this._updateLockUI();
			}
			const wMm = Number.parseFloat(this.$width.value) || 0;
			this._setDirty(true);
			if (wMm > 0) {
				const curMax = Number.parseFloat(this.$widthSlider.max) || 5;
				if (wMm > curMax) {
					this.$widthSlider.max = String(Math.ceil(wMm * 1.5 / 0.5) * 0.5);
				}
				this.$widthSlider.value = wMm;
			}
			if (this.$chartW && document.activeElement !== this.$chartW) {
				this.$chartW.value = wMm > 0 ? wMm.toFixed(3) : '';
			}
			this._setDirty(false);
			this._recalculate();
		},

		/* ---- ΔT Card Handlers ---- */
		_onDTSliderChange() {
			if (this._dirty) return;
			// 操作 ΔT → 自动锁 ΔT
			if (this.lockedParam !== 'deltaT') {
				this.lockedParam = 'deltaT';
				this._updateLockUI();
			}
			const dt = Number.parseFloat(this.$dtSlider.value) || 0;
			this._setDirty(true);
			this.$deltaT.value = String(dt);
			this._setDirty(false);
			this._forwardCalcW();
			this._recalculate();
		},

		_onDTInputChange() {
			if (this._dirty) return;
			if (this.lockedParam !== 'deltaT') {
				this.lockedParam = 'deltaT';
				this._updateLockUI();
			}
			const dt = Number.parseFloat(this.$deltaT.value) || 0;
			this._setDirty(true);
			if (dt > 0) this.$dtSlider.value = dt;
			this._setDirty(false);
			this._forwardCalcW();
			this._recalculate();
		},

		_onLockToggle() {
			/* 点任一把锁都切换：锁定另一个 */
			this.lockedParam = this.lockedParam === 'deltaT' ? 'width' : 'deltaT';
			this._updateLockUI();
			// 切换锁后重新驱动：先正向算 W（若 ΔT 锁定），再统一 reverse
			if (this.lockedParam === 'deltaT') this._forwardCalcW();
			this._recalculate();
		},

		_updateLockUI() {
			const isDT = this.lockedParam === 'deltaT';
			if (this.$lockW) {
				this.$lockW.textContent = isDT ? '🔓' : '🔒';
				this.$lockW.classList.toggle('locked', !isDT);
				this.$lockW.title = isDT ? '点击锁定线宽' : '已锁定线宽';
			}
			if (this.$lockDT) {
				this.$lockDT.textContent = isDT ? '🔒' : '🔓';
				this.$lockDT.classList.toggle('locked', isDT);
				this.$lockDT.title = isDT ? '已锁定温升' : '点击锁定温升';
			}
			// 仅视觉提示，两个滑条始终可操作
		},

		_forwardCalcW() {
			/* 正向：I + ΔT → W，更新 W 滑条 + 输入 */
			const I = Number.parseFloat(this.$current.value) || 0;
			const dT = this._getAllowedDT();
			const tUm = this._getCopperThickness();
			const k = this._getK();
			if (I > 0 && dT > 0 && tUm > 0) {
				const wCurve = this._calcWidthFromTempRise(I, dT, tUm, k);
				if (wCurve > 0) {
					this._setDirty(true);
					this._setWidthValue(wCurve);
					this._setDirty(false);
				}
			}
		},

		_onChartInputChange(source) {
			/* Chart readout 联动 — source 'W' 在 W 锁定模式下代表 ΔT */
			if (this._dirty) return;
			this._setDirty(true);
			const iVal = Number.parseFloat(this.$chartI.value) || 0;
			const v2 = Number.parseFloat(this.$chartW.value) || 0;

			if (source === 'I' && iVal > 0) {
				this.$current.value = iVal.toFixed(2);
			} else if (source === 'W' && v2 > 0) {
				if (this.lockedParam === 'width') {
					// W 锁定 → readout 输入的是 ΔT
					this.$deltaT.value = v2.toFixed(1);
					this.$dtSlider.value = v2;
				} else {
					this._setWidthValue(v2);
				}
			}
			this._setDirty(false);
			// 驱动力：ΔT 锁定 → 正向算 W；W 锁定 → _recalculate 反向算 ΔT
			if (this.lockedParam === 'deltaT') this._forwardCalcW();
			this._recalculate();
		},

		_onCopperSegChange() {
			// Custom input is now inline inside the radio label — no visibility toggle needed
		},

		_autoSelectCopperCustom() {
			const checked = this.$copperSeg.querySelector('input[name="tcCopperThickness"]:checked');
			if (!checked || checked.value !== 'custom') {
				const customRadio = this.$copperSeg.querySelector('input[value="custom"]');
				if (customRadio) {
					customRadio.checked = true;
					this._onCopperSegChange();
				}
			}
		},

		async _onApply() {
			if (this.mode !== 'verify' || this.selectedTraceIds.length === 0) return;
			const wMm = Number.parseFloat(this.$widthSlider.value) || 0;
			if (wMm <= 0) return;

			const eda = FPC.getEda();
			if (!eda) {
				// eslint-disable-next-line no-alert
				alert('未连接到 EDA 编辑器');
				return;
			}

			const wMil = wMm * FPC.MM_TO_MIL;
			let success = 0;
			let fail = 0;
			for (const id of this.selectedTraceIds) {
				try {
					await eda.pcb_PrimitiveLine.modify(id, { lineWidth: Math.round(wMil) });
					success++;
				} catch (err) {
					console.error('[TC] modify failed for', id, err);
					fail++;
				}
			}

			if (eda.sys_Message && eda.sys_Message.showToastMessage) {
				eda.sys_Message.showToastMessage(
					`已应用线宽 ${wMm.toFixed(3)}mm：成功 ${success}，失败 ${fail}`
				);
			}
		},

		/* ================================================================
		   CALCULATION ENGINE
		   ================================================================ */

		_calcWidthFromTempRise(I, dT, tUm, k) {
			if (I <= 0 || dT <= 0 || tUm <= 0) return 0;
			const areaMilsq = (I / (k * Math.pow(dT, 0.44))) ** (1 / 0.725);
			const tMil = tUm / 25.4;
			const wMil = areaMilsq / tMil;
			return wMil * 0.0254;
		},

		_calcTempRiseFromWidth(I, wMm, tUm, k) {
			if (I <= 0 || wMm <= 0 || tUm <= 0) return 0;
			const tMil = tUm / 25.4;
			const wMil = wMm / 0.0254;
			const areaMilsq = tMil * wMil;
			if (areaMilsq <= 0) return 0;
			return (I / (k * Math.pow(areaMilsq, 0.725))) ** (1 / 0.44);
		},

		/** IPC-2221 正向：已知 W 和 ΔT，直接算 I */
		_calcCurrentFromParams(wMm, dT, tUm, k) {
			if (wMm <= 0 || dT <= 0 || tUm <= 0) return Infinity;
			const tMil = tUm / 25.4;
			const wMil = wMm / 0.0254;
			const areaMilsq = tMil * wMil;
			return k * Math.pow(dT, 0.44) * Math.pow(areaMilsq, 0.725);
		},

		_generateIsoCurve(dT, tUm, k) {
			if (dT <= 0 || tUm <= 0) return [];
			const iMax = this._getChartIMax();
			const steps = 100;
			const points = [];
			for (let i = 0; i <= steps; i++) {
				const I = 0.02 + (i / steps) * iMax;
				const W = this._calcWidthFromTempRise(I, dT, tUm, k);
				if (W > 0 && W < 20) points.push({ I, W });
			}
			return points;
		},

		/** 等线宽曲线：固定 W，I 变化 → ΔT（W 锁定模式） */
		_generateIsoWCurve(wMm, tUm, k) {
			if (wMm <= 0 || tUm <= 0) return [];
			const iMax = this._getChartIMax();
			const points = [];
			for (let i = 0; i <= 100; i++) {
				const I = 0.02 + (i / 100) * iMax;
				const dT = this._calcTempRiseFromWidth(I, wMm, tUm, k);
				if (dT > 0 && dT < 500) points.push({ I, Y: dT });
			}
			return points; // { I, Y } where Y = ΔT
		},

		_getChartIMax() {
			const dT = this._getAllowedDT();
			const I = Number.parseFloat(this.$current && this.$current.value) || 0;
			// 覆盖实际电流 1.5x，最小 5A，最大 50A
			return Math.min(50, Math.max(Math.ceil(I * 1.5), Math.ceil(dT * 0.6), 5));
		},

		_getChartWMax() {
			const tUm = this._getCopperThickness();
			const k = this._getK();
			const dT = this._getAllowedDT();
			const iMax = this._getChartIMax();
			const wMax = this._calcWidthFromTempRise(iMax, dT, tUm, k);
			// 上限 20mm，避免极端电流+低ΔT 组合导致 Y 轴撑破
			return Math.min(80, Math.max(1, Math.ceil(wMax * 1.2 / 0.5) * 0.5));
		},

		/** 根据锁定模式返回 Y 轴上限 */
		_getChartYMax() {
			if (this.lockedParam === 'width') {
				const tUm = this._getCopperThickness();
				const k = this._getK();
				const wMm = Number.parseFloat(this.$width.value) || 0;
				const iMax = this._getChartIMax();
				const dTMax = Math.min(500, this._calcTempRiseFromWidth(iMax, wMm, tUm, k));
				return Math.max(20, Math.ceil(dTMax * 1.2 / 10) * 10);
			}
			return this._getChartWMax();
		},

		/* ================================================================
		   PARAM HELPERS
		   ================================================================ */
		_getCopperThickness() {
			const checked = this.$copperSeg ? this.$copperSeg.querySelector('input[name="tcCopperThickness"]:checked') : null;
			if (!checked) return 35;
			if (checked.value === 'custom') {
				return this.$copperCustomInput ? (Number.parseFloat(this.$copperCustomInput.value) || 0) : 0;
			}
			return Number.parseFloat(checked.value) || 0;
		},

		_getLayerPos() {
			const checked = this.$layerSeg ? this.$layerSeg.querySelector('input[name="tcLayer"]:checked') : null;
			return checked ? checked.value : 'external';
		},

		_getK() {
			return this._getLayerPos() === 'external' ? K_EXTERNAL : K_INTERNAL;
		},

		_getAllowedDT() {
			return Number.parseFloat(this.$deltaT.value) || 0;
		},

		_setDirty(v) { this._dirty = v; },

		/** Set width in slider + input + chart, without triggering recalc */
		_setWidthValue(wMm) {
			// 动态扩展滑条上限，防止计算结果被浏览器 clamp 到 max
			const curMax = Number.parseFloat(this.$widthSlider.max) || 5;
			if (wMm > curMax) {
				this.$widthSlider.max = String(Math.ceil(wMm * 1.5 / 0.5) * 0.5);
			}
			this.$widthSlider.value = wMm;
			this.$width.value = wMm.toFixed(3);
			if (this.$chartW && document.activeElement !== this.$chartW) {
				this.$chartW.value = wMm.toFixed(3);
			}
		},

		/* ================================================================
		   MAIN RECALCULATE
		   ================================================================ */
		_recalculate() {
			const I = Number.parseFloat(this.$current.value) || 0;
			const tUm = this._getCopperThickness();
			const dT_allowed = this._getAllowedDT();
			const L = Number.parseFloat(this.$length.value) || 0;
			const k = this._getK();

			let wMm = Number.parseFloat(this.$widthSlider.value) || 0;

			// 首次加载时滑条为 0 → 用正向计算填初始值
			if (wMm <= 0 && I > 0 && tUm > 0 && dT_allowed > 0) {
				const wInit = this._calcWidthFromTempRise(I, dT_allowed, tUm, k);
				if (wInit > 0) {
					this._setDirty(true);
					this._setWidthValue(wInit);
					this._setDirty(false);
					wMm = wInit;
				}
			}

			// ΔT 始终反向计算：ΔT = f(I, W)
			const dT_actual = (I > 0 && tUm > 0 && wMm > 0)
				? this._calcTempRiseFromWidth(I, wMm, tUm, k)
				: 0;

			// Compute R, Vd, P
			// 铜 TCR = 0.0039/°C (25°C 基准)，与嘉立创一致
			let R_mOhm = 0, Vd_mV = 0, P_mW = 0;
			if (I > 0 && wMm > 0 && tUm > 0 && L > 0) {
				const tMm = tUm / 1000;
				const tcrFactor = 1 + 0.0039 * Math.max(0, dT_actual);
				R_mOhm = RHO * L / (tMm * wMm) * tcrFactor;
				Vd_mV = I * R_mOhm;
				P_mW = I * I * R_mOhm;
			}

			// Update DOM — 仅更新"被动"参数（非锁定侧），锁定侧保持用户设定值
			if (this.lockedParam !== 'width' && document.activeElement !== this.$width) {
				this.$width.value = wMm > 0 ? wMm.toFixed(3) : '';
			}
			if (this.lockedParam !== 'deltaT' && document.activeElement !== this.$deltaT) {
				// W 锁定模式下钳位到 500°C，防止极端电流组合产生无意义的 ΔT 值
				const dT_clamped = dT_actual > 500 ? 500 : dT_actual;
				this.$deltaT.value = dT_clamped > 0 ? dT_clamped.toFixed(1) : '';
			}
			// Sync ΔT slider — only when ΔT is the computed result
			if (this.lockedParam !== 'deltaT' && this.$dtSlider && document.activeElement !== this.$dtSlider) {
				const dT_clamped = dT_actual > 500 ? 500 : dT_actual;
				this.$dtSlider.value = dT_clamped > 0 ? dT_clamped : 0;
			}
			this.$resistance.textContent = R_mOhm > 0 ? R_mOhm.toFixed(2) : '--';
			this.$voltageDrop.textContent = Vd_mV > 0 ? Vd_mV.toFixed(2) : '--';
			this.$powerLoss.textContent = P_mW > 0 ? P_mW.toFixed(2) : '--';

			// 图表用实际 ΔT（W 锁定模式需计算值，ΔT 锁定模式 dT_actual ≈ dT_allowed）
		// W 锁定模式下钳位 ΔT 到 500°C，防止极端电流组合撑破图表 Y 轴
		const dT_chart = this.lockedParam === 'width' ? Math.min(500, dT_actual) : dT_actual;
		this._renderChart(I, wMm, dT_chart, tUm, k);

			if (this.$applyBtn) {
				this.$applyBtn.disabled = !(this.mode === 'verify' && wMm > 0);
			}
		},

		/* ================================================================
		   SVG CHART RENDERING
		   ================================================================ */
		_renderChart(I, wMm, dT_allowed, tUm, k) {
			if (!this.$isoCurve || !this.$chartDot || !this.$chartGrid) return;

			const isWLocked = this.lockedParam === 'width';
			const iMax = this._getChartIMax();

			// Y-axis setup per mode
			const yMax = this._getChartYMax();
			const yStep = isWLocked
				? (yMax <= 30 ? 5 : yMax <= 60 ? 10 : yMax <= 150 ? 25 : yMax <= 300 ? 50 : 100)
				: (yMax <= 1 ? 0.2 : yMax <= 2 ? 0.5 : yMax <= 5 ? 1 : yMax <= 10 ? 2 : yMax <= 20 ? 5 : yMax <= 50 ? 10 : 20);
			const yLabel = isWLocked ? 'ΔT (°C)' : 'W (mm)';
			const yVal = isWLocked ? dT_allowed : wMm;

			// Grid: X-axis (unchanged) + Y-axis (dynamic)
			let gridHtml = '';
			const iStep = iMax <= 5 ? 1 : iMax <= 10 ? 2 : 5;
			for (let iv = 0; iv <= iMax; iv += iStep) {
				const x = CHART.PAD_L + (iv / iMax) * CHART.PLOT_W;
				gridHtml += `<line x1="${x}" y1="${CHART.PAD_T}" x2="${x}" y2="${CHART.H - CHART.PAD_B}" stroke="var(--card-divider)" stroke-width="0.5"/>`;
				gridHtml += `<text x="${x}" y="${CHART.H - 8}" text-anchor="middle" font-size="9" fill="var(--text-caption)">${iv}</text>`;
			}
			for (let yv = yStep; yv <= yMax + yStep * 0.5; yv += yStep) {
				const y = CHART.H - CHART.PAD_B - (yv / yMax) * CHART.PLOT_H;
				gridHtml += `<line x1="${CHART.PAD_L}" y1="${y}" x2="${CHART.W - CHART.PAD_R}" y2="${y}" stroke="var(--card-divider)" stroke-width="0.5"/>`;
				gridHtml += `<text x="${CHART.PAD_L - 4}" y="${y + 3}" text-anchor="end" font-size="9" fill="var(--text-caption)">${Number.isInteger(yv) ? yv : yv.toFixed(1)}</text>`;
			}
			this.$chartGrid.innerHTML = gridHtml;

			// Curve: iso-ΔT (W-locked) or iso-W (ΔT-locked)
			if (isWLocked) {
				if (wMm > 0 && tUm > 0) {
					const points = this._generateIsoWCurve(wMm, tUm, k);
					if (points.length > 1) {
						let d = '';
						for (let i = 0; i < points.length; i++) {
							const px = CHART.PAD_L + (points[i].I / iMax) * CHART.PLOT_W;
							const py = CHART.H - CHART.PAD_B - (points[i].Y / yMax) * CHART.PLOT_H;
							d += (i === 0 ? 'M' : 'L') + ` ${px.toFixed(1)},${py.toFixed(1)}`;
						}
						this.$isoCurve.setAttribute('d', d);
					} else {
						this.$isoCurve.setAttribute('d', '');
					}
				} else {
					this.$isoCurve.setAttribute('d', '');
				}
			} else {
				if (dT_allowed > 0 && tUm > 0) {
					const points = this._generateIsoCurve(dT_allowed, tUm, k);
					if (points.length > 1) {
						let d = '';
						for (let i = 0; i < points.length; i++) {
							const px = CHART.PAD_L + (points[i].I / iMax) * CHART.PLOT_W;
							const py = CHART.H - CHART.PAD_B - (points[i].W / yMax) * CHART.PLOT_H;
							d += (i === 0 ? 'M' : 'L') + ` ${px.toFixed(1)},${py.toFixed(1)}`;
						}
						this.$isoCurve.setAttribute('d', d);
					} else {
						this.$isoCurve.setAttribute('d', '');
					}
				} else {
					this.$isoCurve.setAttribute('d', '');
				}
			}

			// Dot + projection lines
			if (I > 0 && yVal > 0) {
				const dx = CHART.PAD_L + Math.min(1, I / iMax) * CHART.PLOT_W;
				const dy = CHART.H - CHART.PAD_B - Math.min(1, yVal / yMax) * CHART.PLOT_H;
				this.$chartDot.setAttribute('cx', dx.toFixed(1));
				this.$chartDot.setAttribute('cy', dy.toFixed(1));
				this.$chartDot.style.display = '';
				// Orthogonal projection lines: dot → axes
				const axisY = CHART.H - CHART.PAD_B;
				if (this.$projX) {
					this.$projX.setAttribute('x1', dx.toFixed(1));
					this.$projX.setAttribute('y1', dy.toFixed(1));
					this.$projX.setAttribute('x2', dx.toFixed(1));
					this.$projX.setAttribute('y2', axisY.toFixed(1));
					this.$projX.style.display = '';
				}
				if (this.$projY) {
					this.$projY.setAttribute('x1', CHART.PAD_L);
					this.$projY.setAttribute('y1', dy.toFixed(1));
					this.$projY.setAttribute('x2', dx.toFixed(1));
					this.$projY.setAttribute('y2', dy.toFixed(1));
					this.$projY.style.display = '';
				}
			} else {
				this.$chartDot.style.display = 'none';
				if (this.$projX) this.$projX.style.display = 'none';
				if (this.$projY) this.$projY.style.display = 'none';
			}

			// Update axis & readout labels
			if (this.$chartYLabel) this.$chartYLabel.textContent = yLabel;
			if (this.$chartLabel2) this.$chartLabel2.textContent = isWLocked ? 'ΔT' : 'W';
			if (this.$chartUnit2) this.$chartUnit2.textContent = isWLocked ? '°C' : 'mm';
			if (this.$chartW) this.$chartW.step = isWLocked ? '1' : '0.01';
		},

		/* ================================================================
		   CANVAS POLLING
		   ================================================================ */
		_lastSelectedSignature: '',

		async pollCanvasSelection() {
			const eda = FPC.getEda();
			if (!eda || !eda.pcb_SelectControl) {
				if (this.mode !== 'manual') {
					this.mode = 'manual';
					this.selectedTraceIds = [];
					this._updateSelectionUI();
				}
				return;
			}

			try {
				const ids = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();
				const normalized = FPC.normalizeSelectionIds(ids);
				const signature = normalized.join('|');
				if (signature === this._lastSelectedSignature) return;
				this._lastSelectedSignature = signature;

				if (normalized.length === 0) {
					this.mode = 'manual';
					this.selectedTraceIds = [];
					this.selectedNetName = '';
					this.selectedNetGroups = [];
					this.selectedNetTotalLen = 0;
					this.selectedTraceLen = 0;
					this.selectedAvgWidth = 0;
					this._updateSelectionUI();
					this._recalculate();
					return;
				}

				await this._detectSelectedTraces(normalized);
			} catch (e) {
				// Polling errors are silent
			}
		},

		async _detectSelectedTraces(ids) {
			const eda = FPC.getEda();
			const traces = [];
			const netMap = new Map(); // net名 → { count, lenMm }
			let netName = null;

			for (const id of ids) {
				try {
					const prim = await eda.pcb_PrimitiveLine.get(id);
					if (!prim) continue;

					const wMil = prim.getState_LineWidth ? prim.getState_LineWidth() : 0;
					const sx = prim.getState_StartX ? prim.getState_StartX() : 0;
					const sy = prim.getState_StartY ? prim.getState_StartY() : 0;
					const ex = prim.getState_EndX ? prim.getState_EndX() : 0;
					const ey = prim.getState_EndY ? prim.getState_EndY() : 0;
					const layer = prim.getState_Layer ? prim.getState_Layer() : null;
					const net = prim.getState_Net ? prim.getState_Net() : '';

					const dx = ex - sx;
					const dy = ey - sy;
					const lenMil = Math.sqrt(dx * dx + dy * dy);
					const lenMm = lenMil / FPC.MM_TO_MIL;

					const netKey = net || '';
					if (!netMap.has(netKey)) netMap.set(netKey, { count: 0, lenMm: 0 });
					const grp = netMap.get(netKey);
					grp.count++;
					grp.lenMm += lenMm;
					if (net && netName === null) netName = net;
					if (net && net !== netName) netName = null;

					let isExternal = null;
					if (layer !== null && layer !== undefined) {
						const layerNum = typeof layer === 'object'
							? (layer.topLayer || layer.bottomLayer || 1)
							: Number(layer);
						isExternal = (layerNum === 1 || layerNum === 2);
					}

					traces.push({ id, wMil, lenMm, isExternal });
				} catch (e) {
					// Skip inaccessible primitives
				}
			}

			if (traces.length === 0) {
				this.mode = 'manual';
				this.selectedTraceIds = [];
				this.selectedNetGroups = [];
				this._updateSelectionUI();
				return;
			}

			const totalLen = traces.reduce((s, t) => s + t.lenMm, 0);
			const avgW = traces.reduce((s, t) => s + t.wMil, 0) / traces.length;
			const avgWMm = avgW / FPC.MM_TO_MIL;

			const extCount = traces.filter(t => t.isExternal === true).length;
			const intCount = traces.filter(t => t.isExternal === false).length;
			const isExternal = extCount >= intCount;

			let netTotalLen = 0;
			if (netName && eda.pcb_Net && eda.pcb_Net.getNetLength) {
				try {
					netTotalLen = await eda.pcb_Net.getNetLength(netName);
					if (typeof netTotalLen === 'number') {
						netTotalLen = netTotalLen / FPC.MM_TO_MIL;
					} else {
						netTotalLen = 0;
					}
				} catch (e) {
					netTotalLen = 0;
				}
			}

			this.mode = 'verify';
			this.selectedTraceIds = traces.map(t => t.id);
			this.selectedNetName = netName || '';
			this.selectedNetGroups = [...netMap.entries()].map(([name, g]) => ({
				name: name || '无网络',
				count: g.count,
				lenMm: g.lenMm
			}));
			this.selectedNetTotalLen = netTotalLen;
			this.selectedTraceLen = totalLen;
			this.selectedAvgWidth = avgWMm;

			this._setDirty(true);
			this.$length.value = totalLen.toFixed(1);
			if (this.$lengthAutoBadge) this.$lengthAutoBadge.hidden = false;

			// Set layer via segment control
			if (this.$layerSeg) {
				this._setSegValue(this.$layerSeg, isExternal ? 'external' : 'internal');
			}

			// Set initial slider to canvas width
			this._setWidthValue(avgWMm);

			this._setDirty(false);
			this._updateSelectionUI();
			this._recalculate();
		},

		/* ================================================================
		   UI UPDATE
		   ================================================================ */
		_updateSelectionUI() {
			if (this.mode === 'verify') {
				if (this.$selDot) this.$selDot.classList.add('active');
				if (this.$selText) {
					const groups = this.selectedNetGroups || [];
					if (groups.length <= 1) {
						// 单网络或无网络 — 保持原样
						const net = this.selectedNetName ? `网络${this.selectedNetName}` : '无网络';
						this.$selText.textContent = `${net} · ${this.selectedTraceIds.length}段导线`;
					} else {
						// 多网络 — 分开显示，总长度不变
						const badges = groups.map(g =>
							`<span class="tc-sel-net-badge">${g.name}(${g.count}段)</span>`
						).join(' ');
						this.$selText.innerHTML = `${badges} <span class="tc-sel-net-total">· 共${this.selectedTraceIds.length}段导线</span>`;
					}
				}
				if (this.$length) this.$length.style.background = 'rgba(var(--accent-rgb), 0.06)';
				if (this.$lengthAutoBadge) this.$lengthAutoBadge.hidden = false;
			} else {
				if (this.$selDot) this.$selDot.classList.remove('active');
				if (this.$selText) this.$selText.textContent = '未选中走线';
				if (this.$length) this.$length.style.background = '';
				if (this.$lengthAutoBadge) this.$lengthAutoBadge.hidden = true;
			}

			if (this.$applyBtn) {
				this.$applyBtn.disabled = (this.mode !== 'verify');
			}
		},

		/* ================================================================
		   POLLING LIFECYCLE
		   ================================================================ */
		_pollTimer: null,

		startPolling() {
			if (this._pollTimer) return;
			this._lastSelectedSignature = '';
			this._pollTimer = setInterval(() => {
				this.pollCanvasSelection();
			}, 500);
		},

		stopPolling() {
			if (this._pollTimer) {
				clearInterval(this._pollTimer);
				this._pollTimer = null;
			}
		},
	};

	FPC.TraceCurrentCalc = TraceCurrentCalc;
})();
