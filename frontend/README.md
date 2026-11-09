# Dashboard (Angular 22, standalone components, signals, Tailwind CSS v4)

- `npm start` - dev server on :4200, proxies `/api` to the API on :3000 (`proxy.conf.json`)
- `npm run build` - production build into `dist/frontend/browser`, served by the API at `/`

Structure: `src/app/api.service.ts` (typed HTTP client + API-key interceptor), `components/` (summary cards,
match table with accept/reject, unmatched lists, audit trail). Zoneless change detection, no NgModules.
