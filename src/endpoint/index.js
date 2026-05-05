import { defineEndpoint } from '@directus/extensions-sdk';
import { performBackup } from '../shared/backup.js';
import { ensureBackupFolder } from '../shared/folder.js';
import { readSettings, writeSettings } from '../shared/settings.js';
import { checkPgTools, runPgRestore } from '../shared/pg.js';
import { syncBackups } from '../shared/sync.js';
import { getFileStream, deleteFromStorage, uploadBackupToStorage } from '../shared/storage.js';
import { randomUUID } from 'crypto';

export default defineEndpoint({
	id: 'dbbackup',
	handler: (router, context) => {
		const { services, getSchema, env, logger, database } = context;

		function requireAdmin(req, res) {
			if (!req.accountability?.admin) {
				res.status(403).json({ errors: [{ message: 'Admin access required' }] });
				return false;
			}
			return true;
		}

		function adminServices(schema) {
			const accountability = { admin: true, role: null, user: null };
			return {
				filesService: new services.FilesService({ schema, accountability }),
				foldersService: new services.FoldersService({ schema, accountability }),
			};
		}

		router.post('/backup', async (req, res) => {
			if (!requireAdmin(req, res)) return;

			try {
				const schema = await getSchema();
				const { filesService, foldersService } = adminServices(schema);

				const fileId = await performBackup({
					filesService,
					foldersService,
					env,
					label: req.body?.label || undefined,
					database,
				});

				res.json({ success: true, file_id: fileId });
			} catch (err) {
				logger.error(`[dbbackup] Backup failed: ${err.message}`);
				res.status(500).json({ errors: [{ message: err.message }] });
			}
		});

		router.get('/backups', async (req, res) => {
			if (!requireAdmin(req, res)) return;

			try {
				const schema = await getSchema();
				const { filesService, foldersService } = adminServices(schema);
				const folderId = await ensureBackupFolder(foldersService);

				const backups = await filesService.readByQuery({
					filter: { folder: { _eq: folderId } },
					sort: ['-uploaded_on'],
					fields: ['id', 'title', 'filename_download', 'filesize', 'uploaded_on'],
				});

				res.json({ data: backups });
			} catch (err) {
				logger.error(`[dbbackup] List failed: ${err.message}`);
				res.status(500).json({ errors: [{ message: err.message }] });
			}
		});

		router.delete('/backup/:fileId', async (req, res) => {
			if (!requireAdmin(req, res)) return;

			try {
				const schema = await getSchema();
				const { filesService, foldersService } = adminServices(schema);
				const folderId = await ensureBackupFolder(foldersService);

				const file = await filesService.readOne(req.params.fileId, {
					fields: ['folder', 'filename_disk'],
				});

				if (file.folder !== folderId) {
					return res.status(400).json({ errors: [{ message: 'File is not in the backup folder' }] });
				}

				await deleteFromStorage(file.filename_disk, env);
				await database('directus_files').where({ id: req.params.fileId }).delete();

				res.json({ success: true });
			} catch (err) {
				logger.error(`[dbbackup] Delete failed: ${err.message}`);
				res.status(500).json({ errors: [{ message: err.message }] });
			}
		});

		router.post('/restore/:fileId', async (req, res) => {
			if (!requireAdmin(req, res)) return;

			try {
				const schema = await getSchema();
				const { foldersService, filesService } = adminServices(schema);
				const folderId = await ensureBackupFolder(foldersService);

				const file = await filesService.readOne(req.params.fileId, {
					fields: ['folder', 'filename_download', 'filename_disk', 'storage'],
				});

				if (file.folder !== folderId) {
					return res.status(400).json({ errors: [{ message: 'File is not in the backup folder' }] });
				}

				const stream = await getFileStream(file, env);

				logger.info(`[dbbackup] Starting restore from ${file.filename_download}...`);

				const result = await runPgRestore(stream, env);

				logger.info(`[dbbackup] Restore complete (exit code ${result.code}). Scheduling restart...`);

				res.json({
					success: true,
					message: 'Restore complete. Server will restart in a few seconds.',
					warnings: result.stderr || null,
				});

				setTimeout(() => {
					logger.info('[dbbackup] Restarting process after restore...');
					process.exit(0);
				}, 3000);
			} catch (err) {
				logger.error(`[dbbackup] Restore failed: ${err.message}`);
				res.status(500).json({ errors: [{ message: err.message }] });
			}
		});

		router.get('/settings', (req, res) => {
			if (!requireAdmin(req, res)) return;

			try {
				const settings = readSettings(env.EXTENSIONS_PATH);
				res.json({ data: settings });
			} catch (err) {
				res.status(500).json({ errors: [{ message: err.message }] });
			}
		});

		router.patch('/settings', (req, res) => {
			if (!requireAdmin(req, res)) return;

			try {
				const current = readSettings(env.EXTENSIONS_PATH);
				const { interval_hours, retention_count } = req.body;

				if (interval_hours !== undefined) {
					const val = parseInt(interval_hours, 10);

					if (isNaN(val) || val < 0) {
						return res.status(400).json({ errors: [{ message: 'interval_hours must be a non-negative integer' }] });
					}

					current.interval_hours = val;
				}

				if (retention_count !== undefined) {
					const val = parseInt(retention_count, 10);

					if (isNaN(val) || val < 1) {
						return res.status(400).json({ errors: [{ message: 'retention_count must be a positive integer' }] });
					}

					current.retention_count = val;
				}

				writeSettings(env.EXTENSIONS_PATH, current);
				res.json({ data: current });
			} catch (err) {
				res.status(500).json({ errors: [{ message: err.message }] });
			}
		});

		router.get('/status', (req, res) => {
			if (!requireAdmin(req, res)) return;

			try {
				const tools = checkPgTools();
				const settings = readSettings(env.EXTENSIONS_PATH);

				res.json({
					data: {
						pg_dump_available: tools.pg_dump,
						pg_restore_available: tools.pg_restore,
						last_backup_at: settings.last_backup_at,
					},
				});
			} catch (err) {
				res.status(500).json({ errors: [{ message: err.message }] });
			}
		});

		router.post('/upload', async (req, res) => {
			if (!requireAdmin(req, res)) return;

			try {
				const chunks = [];
				for await (const chunk of req) {
					chunks.push(chunk);
				}
				const buffer = Buffer.concat(chunks);

				if (buffer.length === 0) {
					return res.status(400).json({ errors: [{ message: 'No file data received' }] });
				}

				const schema = await getSchema();
				const { foldersService } = adminServices(schema);
				const folderId = await ensureBackupFolder(foldersService);

				const label = req.headers['x-backup-label'] || 'Uploaded backup';
				const sanitized = (label || 'Uploaded-backup')
					.replace(/[^a-zA-Z0-9 _-]/g, '')
					.replace(/\s+/g, '-')
					.slice(0, 60);

				const now = new Date();
				const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
				const filename = `backup_${ts}_${sanitized}.dump`;

				const storageLocation = env.STORAGE_BACKUP_LOCATIONS
					? env.STORAGE_BACKUP_LOCATIONS.split(',')[0].trim()
					: 'local';

				const filenameDisk = await uploadBackupToStorage(buffer, filename, env);
				const fileId = randomUUID();

				await database('directus_files').insert({
					id: fileId,
					filename_disk: filenameDisk,
					filename_download: filename,
					title: label,
					type: 'application/octet-stream',
					folder: folderId,
					storage: storageLocation,
					filesize: buffer.length,
					uploaded_on: now.toISOString(),
				});

				res.json({ success: true, file_id: fileId });
			} catch (err) {
				logger.error(`[dbbackup] Upload failed: ${err.message}`);
				res.status(500).json({ errors: [{ message: err.message }] });
			}
		});

		router.post('/sync', async (req, res) => {
			if (!requireAdmin(req, res)) return;

			try {
				const schema = await getSchema();
				const { foldersService } = adminServices(schema);

				const result = await syncBackups({
					foldersService,
					env,
					database,
				});

				res.json({ success: true, ...result });
			} catch (err) {
				logger.error(`[dbbackup] Sync failed: ${err.message}`);
				res.status(500).json({ errors: [{ message: err.message }] });
			}
		});
	},
});
