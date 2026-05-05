import { randomUUID } from 'crypto';
import { runPgDump } from './pg.js';
import { ensureBackupFolder } from './folder.js';
import { readSettings, writeSettings } from './settings.js';
import { uploadBackupToStorage, deleteFromStorage } from './storage.js';

function sanitizeLabel(label) {
	return (label || 'Manual-backup')
		.replace(/[^a-zA-Z0-9 _-]/g, '')
		.replace(/\s+/g, '-')
		.slice(0, 60);
}

export async function performBackup({ filesService, foldersService, env, label, database }) {
	const dumpBuffer = await runPgDump(env);
	const folderId = await ensureBackupFolder(foldersService);

	const now = new Date();
	const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const sanitized = sanitizeLabel(label);
	const filename = `backup_${ts}_${sanitized}.dump`;

	const storageLocation = env.STORAGE_BACKUP_LOCATIONS
		? env.STORAGE_BACKUP_LOCATIONS.split(',')[0].trim()
		: 'local';

	const filenameDisk = await uploadBackupToStorage(dumpBuffer, filename, env);
	const fileId = randomUUID();

	await database('directus_files').insert({
		id: fileId,
		filename_disk: filenameDisk,
		filename_download: filename,
		title: label || 'Manual backup',
		type: 'application/octet-stream',
		folder: folderId,
		storage: storageLocation,
		filesize: dumpBuffer.length,
		uploaded_on: now.toISOString(),
	});

	const settings = readSettings(env.EXTENSIONS_PATH);
	settings.last_backup_at = now.toISOString();
	writeSettings(env.EXTENSIONS_PATH, settings);

	await enforceRetention(database, folderId, settings.retention_count, env);

	return fileId;
}

async function enforceRetention(database, folderId, retentionCount, env) {
	if (!retentionCount || retentionCount <= 0) return;

	const backups = await database('directus_files')
		.where({ folder: folderId })
		.orderBy('uploaded_on', 'asc')
		.select('id', 'filename_disk');

	if (backups.length <= retentionCount) return;

	const toDelete = backups.slice(0, backups.length - retentionCount);

	for (const file of toDelete) {
		await deleteFromStorage(file.filename_disk, env);
		await database('directus_files').where({ id: file.id }).delete();
	}
}
