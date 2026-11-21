<div align="center">

# TerraCommander

**A unified desktop file manager for local files, cloud accounts, and remote storage.**

[![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Mantine](https://img.shields.io/badge/Mantine-9-339AF0?logo=mantine&logoColor=white)](https://mantine.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-24.15+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[Features](#features) · [Architecture](#architecture) · [Getting Started](#getting-started) · [Scripts](#development-scripts) · [Documentation](#documentation)

</div>

---

## Overview

TerraCommander brings local drives, cloud storage accounts, and remote file systems into a single desktop workspace built with **Electron**, **React**, **Mantine**, and **TypeScript**. It is architected with strict process isolation, provider-neutral account and storage abstractions, and a background task queue for reliable file transfers.

---

## Features

### Available Today

- **Unified Storage Workspace** — Browse local file systems and **Google Drive** side by side with configurable displayed locations and multiple accounts per provider.
- **Fast Directory Browsing** — Virtualized file lists (`@tanstack/react-virtual`), keyboard shortcuts, multi-selection, and instant in-directory search.
- **File & Folder Operations** — Copy, cut, paste, rename, delete, drag-and-drop uploads (files and folders), and downloads with overwrite confirmation and directory size inspection.
- **Background Task Queue** — Concurrent uploads, downloads, copies, and moves with live transfer progress, transfer rate reporting, conflict locking, and configurable concurrency limits.
- **Desktop Experience** — Light and dark themes, system-aware language support (**English** and **简体中文**), and persistent user preferences.
- **Security by Default** — Runs with `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`; credentials stay strictly in the main process, and IPC inputs and senders are validated.

### Product Direction

TerraCommander's roadmap expands the same provider-neutral foundation toward:

- Additional protocols and providers: **S3**, **FTP**, **SFTP**, and **WebDAV**
- Cross-provider transfers, folder synchronization, and scheduled backups
- Cross-account search, sharing, and client-side encryption

---

## Getting Started

Coming soon.

### Run in Development

```sh
npm run dev
```

---

## Development Scripts

| Command                      | Description                                                  |
| ---------------------------- | ------------------------------------------------------------ |
| `npm run dev`                | Start the Electron app in development mode with watch reload |
| `npm run check`              | Run formatting check, lint, unit tests, and production build |
| `npm run typecheck`          | Run TypeScript project reference type-checking               |
| `npm run lint`               | Run type-aware Oxlint with warnings denied                   |
| `npm run format`             | Format the repository with Oxfmt                             |
| `npm run format:check`       | Verify formatting with Oxfmt                                 |
| `npm run test`               | Run Vitest unit tests                                        |
| `npm run smoke:google-drive` | Run Google Drive integration smoke test                      |
| `npm run build`              | Type-check and build production bundles                      |
| `npm run pack`               | Build an unpacked desktop application in `dist/`             |
| `npm run dist`               | Build Windows release packages (NSIS installer & portable)   |

