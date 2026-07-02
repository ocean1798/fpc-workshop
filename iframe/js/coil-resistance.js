/**
 * FPC Workshop — Coil Resistance Calculator
 * 线圈板阻值计算器：算线长 / 算线宽 双模式
 */
window.FPC = window.FPC || {};

(function () {
	'use strict';

	const RHO = 0.01851; // 铜电阻率 Ω·mm²/m

	const CoilResistanceCalc = {
		$copperSeg: null,
		$copperCustomInput: null,
		$targetResistance: null,
		$targetResistanceRow: null,
		$lineWidth: null,
		$lineWidthRow: null,
		$lineLength: null,
		$lineLengthRow: null,
		$resultLength: null,
		$resultLengthItem: null,
		$resultWidth: null,
		$resultWidthItem: null,

		init() {
			this.$copperSeg = document.getElementById('crCopperSeg');
			this.$copperCustomInput = document.getElementById('crCopperThicknessCustom');
			this.$targetResistance = document.getElementById('crTargetResistance');
			this.$targetResistanceRow = document.getElementById('crTargetResistanceRow');
			this.$lineWidth = document.getElementById('crLineWidth');
			this.$lineWidthRow = document.getElementById('crLineWidthRow');
			this.$lineLength = document.getElementById('crLineLength');
			this.$lineLengthRow = document.getElementById('crLineLengthRow');
			this.$resultLength = document.getElementById('crResultLength');
			this.$resultLengthItem = document.getElementById('crResultLengthItem');
			this.$resultWidth = document.getElementById('crResultWidth');
			this.$resultWidthItem = document.getElementById('crResultWidthItem');

			const self = this;
			// Radio: 计算模式
			const modeRadios = document.querySelectorAll('input[name="crMode"]');
			modeRadios.forEach((radio) => {
				radio.addEventListener('change', () => { self.onModeChange(); self.calculate(); });
			});

			// Copper thickness radio group
			if (this.$copperSeg) {
				this.$copperSeg.addEventListener('change', (e) => {
					if (!e.target.matches('input[name="crCopperThickness"]')) return;
					self._onCopperSegChange();
					self.calculate();
				});
			}
			if (this.$copperCustomInput) {
				this.$copperCustomInput.addEventListener('input', () => {
					// Auto-switch to "自定义" when user types in custom input
					self._autoSelectCustom();
					self.calculate();
				});
				this.$copperCustomInput.addEventListener('change', () => { self.calculate(); });
			}

			[this.$targetResistance, this.$lineWidth, this.$lineLength].forEach((el) => {
				el.addEventListener('change', () => { self.calculate(); });
				el.addEventListener('input', () => { self.calculate(); });
			});

			this.onModeChange();
			this.calculate();
		},

		_onCopperSegChange() {
			// Custom input is now inline inside the radio label — no visibility toggle needed
		},
		_autoSelectCustom() {
			// When user modifies the custom input, switch radio to "自定义"
			const checked = this.$copperSeg.querySelector('input[name="crCopperThickness"]:checked');
			if (!checked || checked.value !== 'custom') {
				const customRadio = this.$copperSeg.querySelector('input[name="crCopperThickness"][value="custom"]');
				if (customRadio) {
					customRadio.checked = true;
					this._onCopperSegChange();
				}
			}
		},

		_getCopperThickness() {
			const checked = this.$copperSeg ? this.$copperSeg.querySelector('input[name="crCopperThickness"]:checked') : null;
			if (!checked) return 35;
			if (checked.value === 'custom') {
				return this.$copperCustomInput ? (Number.parseFloat(this.$copperCustomInput.value) || 0) : 0;
			}
			return Number.parseFloat(checked.value) || 0;
		},

		getMode() {
			const radio = document.querySelector('input[name="crMode"]:checked');
			return radio ? radio.value : 'length';
		},

		onModeChange() {
			const mode = this.getMode();
			// 算线长模式：需要 目标阻值 + 线宽，结果=线长
			// 算线宽模式：需要 目标阻值 + 线长，结果=线宽
			if (mode === 'length') {
				this.$targetResistanceRow.style.display = '';
				this.$lineWidthRow.style.display = '';
				this.$lineLengthRow.style.display = 'none';
				this.$resultLengthItem.style.display = '';
				this.$resultWidthItem.style.display = 'none';
			}
			else {
				this.$targetResistanceRow.style.display = '';
				this.$lineWidthRow.style.display = 'none';
				this.$lineLengthRow.style.display = '';
				this.$resultLengthItem.style.display = 'none';
				this.$resultWidthItem.style.display = '';
			}
		},

		calculate() {
			const mode = this.getMode();
			const t = this._getCopperThickness() / 1000; // μm → mm
			const R = Number.parseFloat(this.$targetResistance.value) || 0; // Ω
			const W = Number.parseFloat(this.$lineWidth.value) || 0; // mm
			const L = Number.parseFloat(this.$lineLength.value) || 0; // mm

			// R = ρ * L / (t * W)
			// → L = R * t * W / ρ  (算线长)
			// → W = ρ * L / (R * t)  (算线宽)
			if (mode === 'length') {
				// 算线长
				if (t <= 0 || W <= 0) {
					this.$resultLength.textContent = '-- mm';
					this.$resultWidth.textContent = '-- mm';
					return;
				}
				// RHO in Ohm.mm2/m, L input in mm -> result in m, *1000 -> mm
				const resultL = R * t * W / RHO * 1000;
				this.$resultLength.textContent = `${resultL.toFixed(2)} mm`;
				this.$resultWidth.textContent = '-- mm';
			}
			else {
				// 算线宽
				if (t <= 0 || R <= 0 || L <= 0) {
					this.$resultLength.textContent = '-- mm';
					this.$resultWidth.textContent = '-- mm';
					return;
				}
				// RHO in Ohm.mm2/m, L in mm -> divide by 1000 for mm
				const resultW = RHO * L / (R * t) / 1000;
				this.$resultLength.textContent = '-- mm';
				this.$resultWidth.textContent = `${resultW.toFixed(3)} mm`;
			}
		},
	};

	FPC.CoilResistanceCalc = CoilResistanceCalc;
})();
