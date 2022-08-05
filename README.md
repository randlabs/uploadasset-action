# uploadasset-action

A [GitHub Action][github-actions-url] to upload assets to an existing release written in [TypeScript][typescript-url]

[![License][license-image]][license-url]
[![Issues][issues-image]][issues-url]

## Usage

```YML
    ...
    - name: Uploading binaries to release
      id: uploadbin
      uses: randlabs/uploadasset-action@v1.0.0
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      with:
        tag: mytag
    ...
```

### Inputs

```YML
inputs:
  release_id:
    description: 'The ID of the release where files must be uploaded.'
    required: false
  tag:
    description: 'The release tag where files must be uploaded if an ID is not provided. If tag is also empty, the action will try to determine the release id based on the execution context.'
    required: false
  files:
    description: 'A multi-line list of files. If an item contains wildcard, a glob search will be executed.'
    required: true
  delete_filemask:
    description: 'If specified, deletes all existing assets that matches any of the wildcard patterns.'
    required: false
  overwrite:
    description: 'Tries to overwrite an asset if it already exists.'
    required: false
  repo:
    description: 'Target repository in <owner-or-company>/<repository> format.'
    required: false
```

### Outputs

```YML
outputs:
  assets:
    description: 'A JSON array containing id and download url of each uploaded asset.'
```

### Permissions

This Action requires the following permissions on the GitHub integration token:

```YML
permissions:
  contents: write
```

### Environment variables:

`GITHUB_TOKEN` must be set to the workflow's token or the personal access token (PAT) required to accomplish the task.

[typescript-url]: http://www.typescriptlang.org/
[github-actions-url]: https://github.com/features/actions
[license-url]: https://github.com/randlabs/uploadasset-action/blob/master/LICENSE
[license-image]: https://img.shields.io/github/license/randlabs/uploadasset-action.svg
[issues-url]: https://github.com/randlabs/uploadasset-action/issues
[issues-image]: https://img.shields.io/github/issues-raw/randlabs/uploadasset-action.svg
