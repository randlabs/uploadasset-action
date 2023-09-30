import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import { globSync } from 'glob';
import * as mimeTypes from 'mime-types';
import * as path from 'path';
import { getBoolInput, getNumericInput, getOctokit, getRepoOwnerInput } from './helpers';

// -----------------------------------------------------------------------------

async function run(): Promise<void> {
	// Create the GitHub accessor
	const octokit = getOctokit();

	// Get target owner and repository
	const { repo, owner } = getRepoOwnerInput();

	// Get release id
	let releaseId = getNumericInput('release-id', undefined, 1);
	if (!releaseId) {
		// If no id was provided, try with tag
		let tagName = core.getInput('tag');
		if (tagName) {
			if (tagName.startsWith('refs/tags/')) {
				tagName = tagName.substring(10);
				if (tagName.length == 0) {
					throw new Error('invalid `tag` input');
				}
			}
			// Get the release that belong to that tag
			const releaseInfo = await octokit.rest.repos.getReleaseByTag({
				owner,
				repo,
				tag: tagName
			});
			if (releaseInfo.status !== 200) {
				throw new Error('failed to retrieve release from tag');
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
	const deleteFileMasks = core.getMultilineInput('delete-filemask');
	const deleteFileRegexs = [];
	if (deleteFileMasks && deleteFileMasks.length > 0) {
		for (const filemask of deleteFileMasks) {
			deleteFileRegexs.push(wildcardToRegEx(filemask));
		}
	}

	// Get overwrite flags
	const overwrite = getBoolInput('overwrite', true);

	// Populate files
	const filesGlobs = core.getMultilineInput('files');
	if (filesGlobs.length == 0) {
		throw new Error('invalid `files` input');
	}
	const files = [];
	for (const fileGlob of filesGlobs) {
		if (fileGlob.includes('*') || fileGlob.includes('?')) {
			const thisFiles = getFiles(fileGlob);
			files.push(...thisFiles);
		}
		else {
			files.push(fileGlob);
		}
	}
	if (files.length == 0) {
		throw new Error('no files to process');
	}

	// Delete all assets if requested
	if (deleteFileRegexs.length > 0) {
		const assetIdsToDelete: number[] = [];

		for await (const response of octokit.paginate.iterator(
			octokit.rest.repos.listReleaseAssets,
			{
				owner,
				repo,
				release_id: releaseId!,
				per_page: 100
			}
		)) {
			for (const assetInfo of response.data) {
				for (const r of deleteFileRegexs) {
					if (r.test(assetInfo.name)) {
						assetIdsToDelete.push(assetInfo.id);
						break;
					}
				}
			}
		}

		// Delete marked assets
		for (const id of assetIdsToDelete) {
			try {
				await octokit.rest.repos.deleteReleaseAsset({
					owner,
					repo,
					asset_id: id,
				});
			}
			catch (err: any) {
				// Handle release not found error
				if (err.status !== 404 && err.message !== 'Not Found') {
					throw err;
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

		// Load file into memory
		const content = fs.readFileSync(file);

		let tryToDelete = true;
		for (let retryCount = 1; ; ) {
			// Try to upload
			try {
				const assetInfo = await octokit.rest.repos.uploadReleaseAsset({
					owner,
					repo,
					release_id: releaseId!,
					name: assetName,
					data: content as any,
					headers: {
						'content-type': contentType,
						'content-length': contentLength
					}
				});

				uploadedAssets.push({
					id: assetInfo.data.id,
					url: assetInfo.data.browser_download_url
				});

				core.info('-> uploaded');
			}
			catch (err: any) {
				// Handle errors
				if (err.status === 422 && overwrite && tryToDelete) {
					let assetId = 0;

					core.info('-> the asset already exists');
					const realAssetName = normalizeGitHubAssetName(assetName);

					for await (const response of octokit.paginate.iterator(
						octokit.rest.repos.listReleaseAssets,
						{
							owner,
							repo,
							release_id: releaseId!,
							per_page: 100
						}
					)) {
						for (const assetInfo of response.data) {
							if (realAssetName == assetInfo.name) {
								assetId = assetInfo.id;
								break;
							}
						}
						if (assetId > 0) {
							break;
						}
					}

					if (assetId > 0) {
						core.info('-> trying to delete asset with id #' + assetId.toString());

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

							if (tryToDelete != true) {
								tryToDelete = false;
							}
							else {
								throw err;
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

function getFiles(pattern: string): string[] {
	const files = globSync(pattern, {});
	return files || [];
}

// IMPORTANT NOTE: Asset name normalization MAY not strictly adhere to GitHub behavior but it is pretty close.
function normalizeGitHubAssetName(name: string): string {
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

run().catch((err: any) => {
	if (err instanceof Error) {
		core.setFailed(err.message);
	}
	else if (err.toString) {
		core.setFailed(err.toString());
	}
	else {
		core.setFailed('unknown error');
	}
});
