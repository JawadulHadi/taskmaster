import { MeiliSearch } from "meilisearch";

export const meili = new MeiliSearch({
  host: process.env.MEILI_HOST!,
  apiKey: process.env.MEILI_API_KEY,
});

export const policyIndex = meili.index("policies");
