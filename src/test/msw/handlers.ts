import { http, HttpResponse } from "msw";

/**
 * Default MSW handlers for unit/component tests.
 * Override per-test with `server.use(...)`.
 */
export const handlers = [
  http.get("/api/search/providers", ({ request }) => {
    const url = new URL(request.url);
    const library = url.searchParams.get("library") ?? "saves";
    return HttpResponse.json({
      library,
      available: ["local"],
      configured: {
        local: true,
        ollama: false,
        openai: false,
        voyage: false,
      },
      enabled: {
        local: true,
        ollama: false,
        openai: false,
        voyage: false,
      },
      default: "local",
    });
  }),
];
