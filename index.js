'use strict';
const path = require('path');
const {app, BrowserWindow, shell, dialog} = require('electron');
const unusedFilename = require('unused-filename');
const pupa = require('pupa');
const extName = require('ext-name');

const getFilenameFromMime = (name, mime) => {
	const extensions = extName.mime(mime);

	if (extensions.length !== 1) {
		return name;
	}

	return `${name}.${extensions[0].ext}`;
};

function registerListener(session, options, callback = () => {}) {
	const downloadItems = new Set();
	let receivedBytes = 0;
	let completedBytes = 0;
	let totalBytes = 0;
	const activeDownloadItems = () => downloadItems.size;
	const progressDownloadItems = () => receivedBytes / totalBytes;

	options = {
		showBadge: true,
		...options
	};

	const listener = (event, item, webContents) => {
		downloadItems.add(item);
		totalBytes += item.getTotalBytes();

		let hostWebContents = webContents;
		if (webContents.getType() === 'webview') {
			({hostWebContents} = webContents);
		}

		const window_ = BrowserWindow.fromWebContents(hostWebContents);

		const directory = options.directory || app.getPath('downloads');
		let filePath;
		if (options.filename) {
			filePath = path.join(directory, options.filename);
		} else {
			const filename = item.getFilename();
			const name = path.extname(filename) ? filename : getFilenameFromMime(filename, item.getMimeType());
			filePath = unusedFilename.sync(path.join(directory, name));
		}

		const errorMessage = options.errorMessage || 'The download of {filename} was interrupted';

		if (options.saveAs) {
			item.setSaveDialogOptions({defaultPath: filePath});
		} else {
			item.setSavePath(filePath);
		}

		if (typeof options.onStarted === 'function') {
			options.onStarted(item);
		}

		item.on('updated', () => {
			receivedBytes = completedBytes;
			for (const item of downloadItems) {
				receivedBytes += item.getReceivedBytes();
			}

			if (options.showBadge && ['darwin', 'linux'].includes(process.platform)) {
				app.badgeCount = activeDownloadItems();
			}

			if (!window_.isDestroyed()) {
				window_.setProgressBar(progressDownloadItems());
			}

			if (typeof options.onProgress === 'function') {
				const itemTransferredBytes = item.getReceivedBytes();
				const itemTotalBytes = item.getTotalBytes();

				options.onProgress({
					percent: itemTotalBytes ? itemTransferredBytes / itemTotalBytes : 0,
					transferredBytes: itemTransferredBytes,
					totalBytes: itemTotalBytes
				});
			}
		});

		item.on('done', (event, state) => {
			completedBytes += item.getTotalBytes();
			downloadItems.delete(item);

			if (options.showBadge && ['darwin', 'linux'].includes(process.platform)) {
				app.badgeCount = activeDownloadItems();
			}

			if (!window_.isDestroyed() && !activeDownloadItems()) {
				window_.setProgressBar(-1);
				receivedBytes = 0;
				completedBytes = 0;
				totalBytes = 0;
			}

			if (options.unregisterWhenDone) {
				session.removeListener('will-download', listener);
			}

			if (state === 'cancelled') {
				if (typeof options.onCancel === 'function') {
					options.onCancel(item);
				}
			} else if (state === 'interrupted') {
				const message = pupa(errorMessage, {filename: path.basename(filePath)});
				callback(new Error(message));
			} else if (state === 'completed') {
				if (process.platform === 'darwin') {
					app.dock.downloadFinished(filePath);
				}

				if (options.openFolderWhenDone) {
					shell.showItemInFolder(filePath);
				}

				callback(null, item);
			}
		});
	};

	session.on('will-download', listener);
}

module.exports = (options = {}) => {
	app.on('session-created', session => {
		registerListener(session, options, (error, _) => {
			if (error) {
				const errorTitle = options.errorTitle || 'Download Error';
				dialog.showErrorBox(errorTitle, error.message);
			}
		});
	});
};

module.exports.download = (window_, url, options) => new Promise((resolve, reject) => {
	options = {
		...options,
		unregisterWhenDone: true
	};

	registerListener(window_.webContents.session, options, (error, item) => {
		if (error) {
			reject(error);
		} else {
			resolve(item);
		}
	});

	window_.webContents.downloadURL(url);
});
