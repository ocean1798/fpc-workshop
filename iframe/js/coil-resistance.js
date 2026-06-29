/**
 * FPC Workshop — Coil Resistance Calculator
 * 线圈板阻值计算器：算线长 / 算线宽 双模式
 */
const FPC = window.FPC || {};

(function () {
	'use strict';

	const RHO = 0.01851; // 铜电阻率 Ω·mm²/m

	const CoilResistanceCalc = {
		$copperThickness: null,
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
			this.$copperThickness = document.getElementById('crCopperThickness');
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

			[this.$copperThickness, this.$targetResistance, this.$lineWidth, this.$lineLength].forEach((el) => {
				el.addEventListener('change', () => { self.calculate(); });
				el.addEventListener('input', () => { self.calculate(); });
			});

			this.onModeChange();
			this.calculate();
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
			const t = (Number.parseFloat(this.$copperThickness.value) || 0) / 1000; // μm → mm
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
				const resultL = R * t * W / RHO;
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
				const resultW = RHO * L / (R * t);
				this.$resultLength.textContent = '-- mm';
				this.$resultWidth.textContent = `${resultW.toFixed(3)} mm`;
			}
		},
	};

	FPC.CoilResistanceCalc = CoilResistanceCalc;
})();
