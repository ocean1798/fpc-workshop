import * as extensionConfig from '../extension.json';

export function activate(status?: 'onStartupFinished', arg?: string): void {
	// 插件激活时自动打开面板
	openFpcWorkshop();
}

export function openFpcWorkshop(): void {
	var iframeApi = eda.sys_IFrame;
	iframeApi.openIFrame('/iframe/index.html', 1000, 700, 'fpc-workshop-ui', {
		maximizeButton: true,
		minimizeButton: true,
		grayscaleMask: true,
	});
}

export function about(): void {
	var dialogApi = eda.sys_Dialog;
	dialogApi.showInformationMessage(
		`${extensionConfig.displayName} v${extensionConfig.version}\n\n`
		+ `一键将 NSMD 焊盘变换为 SMD 压PAD 设计，提升 FPC 焊盘结合力约 47%`,
		'关于',
	);
}
