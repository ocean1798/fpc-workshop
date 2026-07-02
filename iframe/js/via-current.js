/**
 * FPC Workshop — Via Current Calculator (IPC-2221)
 * 过孔电流计算器
 */
window.FPC = window.FPC || {};

(function () {
	'use strict';

	const K = 0.02; // 过孔系数（与嘉立创一致，IPC-2221 内层用于过孔）

	const ViaCurrentCalc = {
		$diameter: null,
		$wallThickness: null,
		$tempRise: null,
		$requiredCurrent: null,
		$perVia: null,
		$minVias: null,

		init() {
			this.$diameter = document.getElementById('vcDiameter');
			this.$wallThickness = document.getElementById('vcWallThickness');
			this.$tempRise = document.getElementById('vcTempRise');
			this.$requiredCurrent = document.getElementById('vcRequiredCurrent');
			this.$perVia = document.getElementById('vcResultPerVia');
			this.$minVias = document.getElementById('vcResultMinVias');
			const self = this;
			[this.$diameter, this.$wallThickness, this.$tempRise, this.$requiredCurrent].forEach((el) => {
				if (!el) return;
				el.addEventListener('change', () => { self.calculate(); });
				el.addEventListener('input', () => { self.calculate(); });
			});

			this.calculate();
		},

		calculate() {
			const D = Number.parseFloat(this.$diameter.value) || 0; // mm (inner diameter)
			const tWall = Number.parseFloat(this.$wallThickness.value) || 0; // μm
			const dT = Number.parseFloat(this.$tempRise.value) || 0; // ℃
			const I_req = Number.parseFloat(this.$requiredCurrent.value) || 0; // A

			if (D <= 0 || tWall <= 0 || dT <= 0 || I_req <= 0) {
				this.$perVia.textContent = '-- A';
				this.$minVias.textContent = '-- 个';
				return;
			}

			// 过孔周长 = π * D
			const perimeterMm = Math.PI * D;

			// 转换到 mil: 1mm = 39.3701 mil
			const perimeterMil = perimeterMm * 39.3701;
			const tWallMil = tWall / 25.4; // μm → mil

			// 热传导面积 = 周长(mil) * 铜厚(mil)  [mil²]
			const areaMilsq = perimeterMil * tWallMil;

			// 每孔最大电流 I = k * dT^0.44 * A^0.725
			const I_perVia = K * dT ** 0.44 * areaMilsq ** 0.725;

			// 最少过孔数 = ceil(I_req / I_perVia) + 1（保险余量）
			const minVias = Math.ceil(I_req / I_perVia) + 1;

			this.$perVia.textContent = `${I_perVia.toFixed(3)} A`;
			this.$minVias.textContent = `${minVias} 个`;
		},
	};

	FPC.ViaCurrentCalc = ViaCurrentCalc;
})();
