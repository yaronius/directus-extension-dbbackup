import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const BACKUP_PREFIX = 'db-backups';

function getStorageConfig(env) {
	const storageLocation = env.STORAGE_BACKUP_LOCATIONS
		? env.STORAGE_BACKUP_LOCATIONS.split(',')[0].trim()
		: 'local';
	const prefix = storageLocation.toUpperCase();
	const driverKey = `STORAGE_${prefix}_DRIVER`;
	const driver = env[driverKey] || 'local';
	return { storageLocation, prefix, driver };
}

function getS3Client(env, prefix) {
	return new S3Client({
		endpoint: env[`STORAGE_${prefix}_ENDPOINT`],
		region: env[`STORAGE_${prefix}_REGION`] || 'auto',
		credentials: {
			accessKeyId: env[`STORAGE_${prefix}_KEY`],
			secretAccessKey: env[`STORAGE_${prefix}_SECRET`],
		},
		forcePathStyle: true,
	});
}

function getS3Key(filenameDisk, env, prefix) {
	const root = env[`STORAGE_${prefix}_ROOT`] || '';
	return root ? `${root}/${filenameDisk}` : filenameDisk;
}

export async function getFileStream(fileRecord, env) {
	const { prefix, driver } = getStorageConfig(env);

	if (driver === 's3') {
		const client = getS3Client(env, prefix);
		const key = getS3Key(fileRecord.filename_disk, env, prefix);
		const response = await client.send(new GetObjectCommand({
			Bucket: env[`STORAGE_${prefix}_BUCKET`],
			Key: key,
		}));
		return response.Body;
	} else {
		const uploadsDir = env.STORAGE_LOCAL_ROOT || join(process.cwd(), 'uploads');
		return createReadStream(join(uploadsDir, fileRecord.filename_disk));
	}
}

export async function uploadBackupToStorage(buffer, filename, env) {
	const { prefix, driver } = getStorageConfig(env);
	const filenameDisk = `${BACKUP_PREFIX}/${filename}`;

	if (driver === 's3') {
		const client = getS3Client(env, prefix);
		const key = getS3Key(filenameDisk, env, prefix);
		await client.send(new PutObjectCommand({
			Bucket: env[`STORAGE_${prefix}_BUCKET`],
			Key: key,
			Body: buffer,
			ContentType: 'application/octet-stream',
		}));
	} else {
		const uploadsDir = env.STORAGE_LOCAL_ROOT || join(process.cwd(), 'uploads');
		const dir = join(uploadsDir, BACKUP_PREFIX);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(join(uploadsDir, filenameDisk), buffer);
	}

	return filenameDisk;
}

export async function listBackupFiles(env) {
	const { prefix, driver } = getStorageConfig(env);

	if (driver === 's3') {
		return listS3Backups(env, prefix);
	} else {
		return listLocalBackups(env);
	}
}

async function listS3Backups(env, prefix) {
	const client = getS3Client(env, prefix);
	const bucket = env[`STORAGE_${prefix}_BUCKET`];
	const root = env[`STORAGE_${prefix}_ROOT`] || '';
	const searchPrefix = root
		? `${root}/${BACKUP_PREFIX}/`
		: `${BACKUP_PREFIX}/`;

	const files = [];
	let continuationToken;

	do {
		const response = await client.send(new ListObjectsV2Command({
			Bucket: bucket,
			Prefix: searchPrefix,
			ContinuationToken: continuationToken,
		}));

		if (response.Contents) {
			for (const obj of response.Contents) {
				let key = obj.Key;
				if (root && key.startsWith(`${root}/`)) {
					key = key.slice(root.length + 1);
				}

				if (key && key.endsWith('.dump')) {
					files.push({
						key,
						size: obj.Size,
						lastModified: obj.LastModified?.toISOString(),
					});
				}
			}
		}

		continuationToken = response.NextContinuationToken;
	} while (continuationToken);

	return files;
}

function listLocalBackups(env) {
	const uploadsDir = env.STORAGE_LOCAL_ROOT || join(process.cwd(), 'uploads');
	const dir = join(uploadsDir, BACKUP_PREFIX);
	const files = [];

	try {
		if (!existsSync(dir)) return files;
		const entries = readdirSync(dir);

		for (const entry of entries) {
			if (!entry.endsWith('.dump')) continue;
			const fullPath = join(dir, entry);

			try {
				const stat = statSync(fullPath);
				if (stat.isFile()) {
					files.push({
						key: `${BACKUP_PREFIX}/${entry}`,
						size: stat.size,
						lastModified: stat.mtime.toISOString(),
					});
				}
			} catch {}
		}
	} catch {}

	return files;
}

export function parseLabelFromFilename(filenameDisk) {
	const basename = filenameDisk.split('/').pop() || '';
	const match = basename.match(/^backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_(.+)\.dump$/);
	if (match) {
		return match[1].replace(/-/g, ' ');
	}
	return 'Recovered backup';
}

export async function deleteFromStorage(filenameDisk, env) {
	const { prefix, driver } = getStorageConfig(env);

	if (driver === 's3') {
		const client = getS3Client(env, prefix);
		const key = getS3Key(filenameDisk, env, prefix);
		await client.send(new DeleteObjectCommand({
			Bucket: env[`STORAGE_${prefix}_BUCKET`],
			Key: key,
		}));
	} else {
		const uploadsDir = env.STORAGE_LOCAL_ROOT || join(process.cwd(), 'uploads');
		const filePath = join(uploadsDir, filenameDisk);
		try {
			if (existsSync(filePath)) unlinkSync(filePath);
		} catch {}
	}
}
