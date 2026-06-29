/**
 * FPC Workshop — Trace Current Calculator (IPC-2221)
 * 线路耐电流计算器
 */
window.FPC = window.FPC || {};

(function () {
	'use strict';

	const RHO = 0.01851; // 铜电阻率 Ω·mm²/m (20℃)
	// IPC-2221 系数
	const K_EXTERNAL = 0.048; // 外层
	const K_INTERNAL = 0.024; // 内层

	const TraceCurrentCalc = {
		$current: null,
		$tempRise: null,
		$length: null,
		$ambientTemp: null,
		$width: null,
		$resistance: null,
		$voltageDrop: null,
		$powerLoss: null,

		init() {
			this.$current = document.getElementById('tcCurrent');
			this.$tempRise = document.getElementById('tcTempRise');
			this.$length = document.getElementById('tcLength');
			this.$ambientTemp = document.getElementById('tcAmbientTemp');
			this.$width = document.getElementById('tcResultWidth');
			this.$resistance = document.getElementById('tcResultResistance');
			this.$voltageDrop = document.getElementById('tcResultVoltageDrop');
			this.$powerLoss = document.getElementById('tcResultPowerLoss');

			const self = this;
			[this.$current, this.$tempRise, this.$length, this.$ambientTemp].forEach((el) => {
				if (el) {
					el.addEventListener('change', () => { self.calculate(); });
					el.addEventListener('input', () => { self.calculate(); });
				}
			});

			// Radio: 铜厚 (5 options, last = 自定义)
			const copperRadios = document.querySelectorAll('input[name="tcCopperThickness"]');
			copperRadios.forEach((radio) => {
				radio.addEventListener('change', () => { self.onCopperChange(); self.calculate(); });
			});

			// 自定义铜厚输入
			const customInput = document.getElementById('tcCopperThicknessCustom');
			if (customInput) {
				customInput.addEventListener('change', () => { self.calculate(); });
				customInput.addEventListener('input', () => { self.calculate(); });
			}

			// Radio: 跟踪层
			const layerRadios = document.querySelectorAll('input[name="tcLayerPos"]');
			layerRadios.forEach((radio) => {
				radio.addEventListener('change', () => { self.calculate(); });
			});

			this.onCopperChange();
			this.calculate();
		},

		/** 铜厚 radio 切换时，控制自定义输入框的启用/禁用状态 */
		onCopperChange() {
			const copperRadio = document.querySelector('input[name="tcCopperThickness"]:checked');
			const isCustom = copperRadio && copperRadio.value === 'custom';
			const customInput = document.getElementById('tcCopperThicknessCustom');
			if (customInput) {
				customInput.disabled = !isCustom;
				customInput.style.opacity = isCustom ? '1' : '0.4';
			}
		},

		/** 读取当前选中的铜厚值 (μm) */
		getCopperThickness() {
			const copperRadio = document.querySelector('input[name="tcCopperThickness"]:checked');
			if (!copperRadio)
				return 0;
			if (copperRadio.value === 'custom') {
				const customInput = document.getElementById('tcCopperThicknessCustom');
				return customInput ? (Number.parseFloat(customInput.value) || 0) : 0;
			}
			return Number.parseFloat(copperRadio.value) || 0;
		},

		/** 读取当前选中的跟踪层 */
		getLayerPos() {
			const radio = document.querySelector('input[name="tcLayerPos"]:checked');
			return radio ? radio.value : 'external';
		},

		calculate() {
			const I = Number.parseFloat(this.$current.value) || 0;
			const t = this.getCopperThickness(); // μm
			const dT = Number.parseFloat(this.$tempRise.value) || 0; // ℃
			const L = Number.parseFloat(this.$length.value) || 0; // mm
			const isExternal = this.getLayerPos() === 'external';
			const k = isExternal ? K_EXTERNAL : K_INTERNAL;

			if (I <= 0 || t <= 0 || dT <= 0 || L <= 0) {
				this.$width.textContent = '-- mm';
				this.$resistance.textContent = '-- mΩ';
				this.$voltageDrop.textContent = '-- mV';
				if (this.$powerLoss)
					this.$powerLoss.textContent = '-- mW';
				return;
			}

			// IPC-2221: A = (I / (k * dT^0.44))^(1/0.725)  [mil²]
			const areaMilsq = (I / (k * dT ** 0.44)) ** (1 / 0.725);

			// 铜厚转 mil: 1mil = 25.4um → mil = um / 25.4
			const tMil = t / 25.4;

			// 线宽 mil: W = A / tMil
			const wMil = areaMilsq / tMil;
			const wMm = wMil * 0.0254; // 1mil = 0.0254mm

			// 电阻 R = ρ * L / (t * W)  [单位: Ω]
			// ρ = 0.01851 Ω·mm²/m
			// t in mm, W in mm, L in mm
			const tMm = t / 1000;
			const R_mOhm = RHO * L / (tMm * wMm) * 1000; // → mΩ

			// 压降 V = I * R [mV]
			const Vd = I * R_mOhm;

			// 功率损耗 P = I² * R [mW]
			const P_mW = I * I * R_mOhm;

			this.$width.textContent = `${wMm.toFixed(3)} mm`;
			this.$resistance.textContent = `${R_mOhm.toFixed(2)} mΩ`;
			this.$voltageDrop.textContent = `${Vd.toFixed(2)} mV`;
			if (this.$powerLoss)
				this.$powerLoss.textContent = `${P_mW.toFixed(2)} mW`;
		},
	};

	FPC.TraceCurrentCalc = TraceCurrentCalc;
})();
