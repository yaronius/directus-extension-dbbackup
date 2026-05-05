import { randomUUID } from 'crypto';
import { ensureBackupFolder } from './folder.js';
import { listBackupFiles, parseLabelFromFilename } from './storage.js';

export async function syncBackups({ foldersService, env, database }) {
	const folderId = await ensureBackupFolder(foldersService);

	const knownFiles = await database('directus_files').select('filename_disk');
	const knownDiskNames = new Set(knownFiles.map((f) => f.filename_disk));

	const storageFiles = await listBackupFiles(env);

	const orphaned = storageFiles.filter((f) => !knownDiskNames.has(f.key));

	if (orphaned.length === 0) {
		return { recovered: 0, files: [] };
	}

	const storageLocation = env.STORAGE_BACKUP_LOCATIONS
		? env.STORAGE_BACKUP_LOCATIONS.split(',')[0].trim()
		: 'local';

	const recovered = [];

	for (const file of orphaned) {
		const label = parseLabelFromFilename(file.key);
		const basename = file.key.split('/').pop() || file.key;
		const newId = randomUUID();

		await database('directus_files').insert({
			id: newId,
			filename_disk: file.key,
			filename_download: basename,
			title: label,
			type: 'application/octet-stream',
			folder: folderId,
			storage: storageLocation,
			filesize: file.size || null,
			uploaded_on: file.lastModified || new Date().toISOString(),
		});

		recovered.push({
			id: newId,
			filename: basename,
			label,
			size: file.size,
		});
	}

	return { recovered: recovered.length, files: recovered };
}
