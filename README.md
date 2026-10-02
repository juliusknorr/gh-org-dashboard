# gh-org-dashboard

Local dashboard for all issues and pull requests of a GitHub org.

```sh
npm install
npm run build && npm start        # http://localhost:3001
# or for development:
npm run server & npm run dev      # http://localhost:5173
```

- `ORG` (default `Euro-Office`), `GITHUB_TOKEN` (default: `gh auth token`), `PORT` (default `3001`)
- Data is synced every 5 minutes into `data/dashboard.db`
- Filters live in the URL, bookmark a view to save it
