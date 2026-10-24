import { load, pageView } from "../lib/bot.js";
import { json, route, signedIn } from "../lib/http.js";

export const GET = route(async (request) => {
  const record = await signedIn(request);
  return json(200, pageView(record, await load(record.id)));
});
