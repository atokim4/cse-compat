import { PARAMS, PARAM_NAMES } from "./params.js";

/**
 * A Google API Discovery document for this server, generated from the same parameter table the
 * validator uses. google-api-python-client (and so LangChain's GoogleSearchAPIWrapper) can build a
 * client from it with `discoveryServiceUrl=`, and every request then goes to `rootUrl`.
 */
export function discoveryDocument(baseUrl: string): Record<string, unknown> {
  const rootUrl = `${baseUrl}/`;
  const parameters = Object.fromEntries(
    PARAM_NAMES.map((name) => {
      const spec = PARAMS[name];
      const param: Record<string, unknown> = { type: spec.type, location: "query", description: spec.description };
      if (spec.type === "integer") param.format = "int32";
      // No `enum` here: googleapiclient rejects values outside an enum client-side, and Google's own
      // document lists imgSize in uppercase, which made lowercase imgSize fail before any request.
      return [name, param];
    }),
  );
  const listMethod = (id: string, path: string) => ({
    id,
    path,
    flatPath: path,
    httpMethod: "GET",
    parameters,
    parameterOrder: [],
    response: { $ref: "Search" },
    description: "Returns metadata about the search performed, metadata about the engine used for the search, and the search results.",
  });

  return {
    kind: "discovery#restDescription",
    discoveryVersion: "v1",
    id: "customsearch:v1",
    name: "customsearch",
    version: "v1",
    title: "Custom Search API (cse-compat)",
    description: "Custom Search JSON API v1 wire format served by cse-compat.",
    protocol: "rest",
    rootUrl,
    servicePath: "",
    baseUrl: rootUrl,
    batchPath: "batch",
    parameters: {
      key: { type: "string", location: "query", description: "API key." },
      alt: { type: "string", location: "query", default: "json", enum: ["json"], description: "Data format for response." },
      fields: { type: "string", location: "query", description: "Selector specifying which fields to include in a partial response." },
      prettyPrint: { type: "boolean", location: "query", default: "true", description: "Returns response with indentations and line breaks." },
      quotaUser: { type: "string", location: "query", description: "Accepted for compatibility; not used." },
      callback: { type: "string", location: "query", description: "JSONP" },
    },
    resources: {
      cse: {
        methods: { list: listMethod("search.cse.list", "customsearch/v1") },
        resources: {
          siterestrict: { methods: { list: listMethod("search.cse.siterestrict.list", "customsearch/v1/siterestrict") } },
        },
      },
    },
    schemas: {
      Search: { id: "Search", type: "object", description: "Response to a custom search request." },
    },
  };
}
