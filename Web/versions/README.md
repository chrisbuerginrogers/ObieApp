# ObieWebApp — Version Archive

This folder holds frozen snapshots of the site, one subfolder per version (e.g. `1.1.2/`).

## How to archive a version

1. **Finish your changes** and confirm the current `Web/version.js` shows the version you want to freeze.
2. **Run the archive script** from the repo root:
   ```bash
   ./archive-version.sh
   ```
   This copies the entire `Web/` tree (excluding this `versions/` folder) into `versions/X.Y.Z/` and updates `versions.js`.
3. **Bump `Web/version.js`** to the next version number to begin the next round of work.
4. **Commit and push** — the new snapshot appears in the home-page version dropdown automatically on GitHub Pages.

## File reference

| File | Purpose |
|---|---|
| `Web/version.js` | Live site's current version number — the only one you ever edit |
| `Web/versions/versions.js` | Auto-updated manifest used by the home-page dropdown on localhost |
| `Web/versions/X.Y.Z/` | Frozen snapshot — never edit anything inside here |
| `Web/versions/X.Y.Z/version.js` | Frozen record of that snapshot's version — do not touch |

## How the version dropdown works

- **On GitHub Pages**: reads the actual `versions/` directory listing via the GitHub API — no manifest update needed, just commit the folder.
- **On localhost**: falls back to `versions.js` (kept in sync by the archive script).
