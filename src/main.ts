import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as glob from 'glob';
import * as mimeTypes from 'mime-types';
import * as path from 'path';

// -----------------------------------------------------------------------------

async function run(): Promise<void> {
	try {
		// Ensure the github token is passed through environment variables
		const token = process.env.GITHUB_TOKEN;
		if (!token) {
			throw new Error('GITHUB_TOKEN environment variable not found. pass `GITHUB_TOKEN` as env');
		}

		// Create the GitHub accessor
		const octokit = github.getOctokit(token);

		// Get target owner and repository
		let { repo, owner } = github.context.repo;
		const ownerRepo = core.getInput('repo');
		if (ownerRepo) {
			const ownerRepoItems = ownerRepo.split('/');
			if (ownerRepoItems.length != 2) {
				throw new Error('the specified `repo` is invalid');
			}
			owner = ownerRepoItems[0].trim();
			repo = ownerRepoItems[1].trim();
			if (owner.length == 0 || repo.length == 0) {
				throw new Error('the specified `repo` is invalid');
			}
		}

		// Get release id
		let releaseId = 0;

		let input = core.getInput('release_id');
		if (input) {
			releaseId = parseInt(input, 10);
			if (Number.isNaN(releaseId) || releaseId < 1) {
				throw new Error('invalid `release_id` input');
			}
		}
		else {
			// If no id was provided, try with tag
			const tagName = core.getInput('tag');
			if (tagName) {
				// Get the release that belong to that tag
				const releaseInfo = await octokit.rest.repos.getReleaseByTag({
					owner,
					repo,
					tag: tagName
				});
				if (releaseInfo.status !== 200) {
					throw new Error('Failed to retrieve release from tag');
				}

				releaseId = releaseInfo.data.id;
			}
			else {
				// Try to get the release id from context
				switch (github.context.payload.action) {
					case 'published':
					case 'created':
					case 'prereleased':
						releaseId = github.context.payload.release.id;
						break;

					default:
						throw new Error('unable to determine the release id');
				}
			}
		}

		// Get delete all flags
		const deleteFileMasks = core.getMultilineInput('delete_filemask');
		const deleteFileRegexs = [];
		if (deleteFileMasks && deleteFileMasks.length > 0) {
			for (const filemask of deleteFileMasks) {
				deleteFileRegexs.push(wildcardToRegEx(filemask));
			}
		}

		// Get overwrite flags
		input = core.getInput('overwrite');
		const overwrite = (!input) || isYes(input);

		// Populate files
		const filesGlobs = core.getMultilineInput('files');
		if ((!filesGlobs) || filesGlobs.length == 0) {
			throw new Error('invalid `files` input');
		}
		const files = [];
		for (const fileGlob of filesGlobs) {
			if (fileGlob.includes('*') || fileGlob.includes('?')) {
				let thisFiles = await getFiles(fileGlob);
				files.push(...thisFiles);
			}
			else {
				files.push(fileGlob);
			}
		}
		if (files.length == 0) {
			throw new Error('No files to process');
		}

		// Delete all assets if requested
		if (deleteFileRegexs.length > 0) {
			let currentOffset = 0;

			for (let done = false; !done;) {
				done = true;

				const assetsListInfo = await octokit.rest.repos.listReleaseAssets({
					owner,
					repo,
					release_id: releaseId,
					page: Math.floor(currentOffset / 100),
					per_page: 100,
				});

				const toSkip = currentOffset - Math.floor(currentOffset / 100);
				const assetsList = assetsListInfo.data.slice(toSkip);

				for (const assetInfo of assetsList) {
					let deleteAsset = false;
					for (const r of deleteFileRegexs) {
						if (r.test(assetInfo.name)) {
							deleteAsset = true;
							break;
						}
					}

					// Should this asset be deleted?
					if (deleteAsset) {
						done = false; // Signal we will have to continue

						try {
							await octokit.rest.repos.deleteReleaseAsset({
								owner,
								repo,
								asset_id: assetInfo.id,
							});
						}
						catch (err: any) {
							// Handle release not found error
							if (err.status !== 404 && err.message !== 'Not Found') {
								throw err;
							}
						}
					}
					else {
						currentOffset += 1;
					}
				}
			}
		}

		// Prepare output
		const uploadedAssets = [];

		// Upload each file
		for (const file of files) {
			core.info('Uploading ' + file + '...');

			const assetName = path.basename(file);

			// Determine content-length
			const contentLength = fs.statSync(file).size;
			
			// Guess mime type
			const contentType = mimeTypes.lookup(assetName) || 'application/octet-stream';

			let tryToDelete = true;
			for (let retryCount = 1; ; ) {
				// Try to upload
				try {
					const assetInfo = await octokit.rest.repos.uploadReleaseAsset({
						owner,
						repo,
						release_id: releaseId,
						name: assetName,
						data: fs.readFileSync(file, 'binary'),
						headers: {
							'content-type': contentType,
							'content-length': contentLength
						}
					});

					uploadedAssets.push({
						id: assetInfo.data.id,
						url: assetInfo.data.browser_download_url
					});
				}
				catch (err: any) {
					// Handle errors
					if (err.status === 422 && overwrite && tryToDelete) {
						let assetId = 0;

						const realAssetName = normalizeGithubAssetName(assetName);

						const assetsListInfo = await octokit.rest.repos.listReleaseAssets({
							owner,
							repo,
							release_id: releaseId,
							page: 0,
							per_page: 100,
						});
						for (const assetInfo of assetsListInfo.data) {
							if (realAssetName == assetInfo.name) {
								assetId = assetInfo.id;
								break;
							}
						}

						if (assetId > 0) {
							// Try to delete existing asset
							try {
								await octokit.rest.repos.deleteReleaseAsset({
									owner,
									repo,
									asset_id: assetId,
								});
							}
							catch (err2: any) {
								// Handle release not found error
								if (err2.status !== 404 && err2.message !== 'Not Found') {
									throw err2;
								}
							}

							// Retry
							continue;
						}

						// The asset was not found (deleted in parallel??)
						if (tryToDelete != true) {
							tryToDelete = false

							// Retry
							continue;
						}

						throw err;
					}

					// On server/upload error, retry
					if ((typeof err.status !== 'number' || err.status >= 500) && retryCount > 0) {
						retryCount -= 1;
						// Retry
						continue;
					}

					throw err;
				}

				// Update succeeded
				break;
			}
		}

		// Set action's output
		core.setOutput('assets', JSON.stringify(uploadedAssets));
	}
	catch (err: any) {
		if (err instanceof Error) {
			core.setFailed(err.message);
		}
		else if (err.toString) {
			core.setFailed(err.toString());
		}
		else {
			core.setFailed('unknown error');
		}
	}
}

function isYes(input: string): boolean {
	return (input === 'true') || (input === 'yes') || (input === 'y') || (input === '1')
}

async function getFiles(pattern: string): Promise<string[]> {
	return await new Promise((resolve, reject) => {
		return glob.glob(pattern, {}, (err, files) => {
			if (err) {
				return reject(err);
			}
			if (files == null || files.length == 0) {
				return resolve([]);
			}
			return resolve(files);
		});
	});
}

// IMPORTANT NOTE: Asset name normalization MAY not strictly adhere to GitHub behavior but it is pretty close.
function normalizeGithubAssetName(name: string): string {
	name = name.normalize('NFD') // Canonical decomposition
			.replace(/[\u0300-\u036F]/g, '') // Remove combining accents
			.replace(/[^a-zA-Z0-9\.\-\_]/g, '') // Remove non alphanumeric characters with some exceptions
			.replace(/\.+$/g, ''); // Remove trailing dots
	const startsWithDot = name.startsWith('.'); // Remember if the name starts with a dot
	name = name.replace(/^\.+/g, ''); // Remove leading dots
	if (startsWithDot) {
		name = 'default.' + name; // If the name starts with a dot, add the 'default' name
	}
	// Done
	return name;
}

function wildcardToRegEx(pattern: string): RegExp {
	return new RegExp('^' + 
		pattern.replace('.', '\\.') // Escape single dots
			.replace('*', '.*') // Replace asterisks and question marks with the regex counterpart
			.replace('?', '.?') +
		'$', 'giu');
}

// -----------------------------------------------------------------------------

run();
