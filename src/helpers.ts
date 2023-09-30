import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from 'octokit';
import fetch, { Response } from 'node-fetch';
import { ProxyAgent } from 'proxy-agent';

// -----------------------------------------------------------------------------

export interface RepoOwner {
	repo: string;
	owner: string;
}

// -----------------------------------------------------------------------------

export function getOctokit(tokenInput?: string): Octokit {
	let token = '';
	if (tokenInput) {
		token = core.getInput(tokenInput);
	}
	if (!token) {
		token = process.env.GITHUB_TOKEN || '';
		if (!token) {
			const msg = (tokenInput) ? ' and no input `' + tokenInput + '` present' : '';
			throw new Error('GITHUB_TOKEN environment variable not found' + msg);
		}
	}

	const agent = new ProxyAgent();
	const octokit = new Octokit({
		auth: token,
		log: {
			debug: () => {},
			info: (message: string) => core.info(message),
			warn: (message: string) => core.warning(message),
			error: (message: string) => core.error(message)
		},
		request: {
			fetch: async (url: any, options?: any): Promise<Response> => {
				options = Object.assign({}, options, {
					agent
				})
				return fetch(url, options);
			}
		}
	});

	Object.defineProperty(octokit, '__token__', {
		value: token,
		writable: false,
		enumerable: false,
		configurable: false
	});

	return octokit;
}

export function getToken(octokit: Octokit): string {
	return (octokit as any).__token__ as string;
}

export function getBoolInput(name: string, def?: boolean): boolean | undefined {
	let input = core.getInput(name);
	if (!input) {
		return def;
	}
	input = input.toLowerCase();
	if (input == 'true' || input == 'yes' || input == 'y' || input == '1') {
		return true;
	}
	if (input == 'false' || input == 'no' || input == 'n' || input == '0') {
		return false;
	}
	throw new Error('invalid `' + name + '` input');
}

export function getNumericInput(name: string, def?: number, min?: number, max?: number): number | undefined {
	let input = core.getInput(name);
	if (!input) {
		return def;
	}
	const value = parseInt(input, 10);
	if (Number.isNaN(value)) {
		throw new Error('invalid `' + name + '` input');
	}
	if ((typeof min !== 'undefined' && value < min) || (typeof max !== 'undefined' && value > max)) {
		throw new Error('input `' + name + '` is out of range');
	}
	return value;
}

export function getRepoOwner(): RepoOwner {
	return {
		repo: github.context.repo.repo,
		owner: github.context.repo.owner
	};
}

export function getRepoOwnerInput(name?: string): RepoOwner {
	name = name || 'repo';
	const input = core.getInput(name);
	if (!input) {
		return getRepoOwner();
	}

	const items = input.split('/');
	if (items.length != 2) {
		throw new Error('invalid `' + name + '` input');
	}

	const res = {
		repo: items[1].trim(),
		owner: items[0].trim()
	}
	if (res.owner.length == 0 || res.repo.length == 0) {
		throw new Error('invalid `' + name + '` input');
	}
	return res;
}
