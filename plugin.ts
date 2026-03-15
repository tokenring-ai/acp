import {TokenRingPlugin} from "@tokenring-ai/app";
import {z} from "zod";
import ACPService from "./ACPService.ts";
import packageJSON from "./package.json" with {type: "json"};
import {ACPConfigSchema} from "./schema.ts";

const packageConfigSchema = z.object({
  acp: ACPConfigSchema.optional(),
});

export default {
  name: packageJSON.name,
  version: packageJSON.version,
  description: packageJSON.description,
  install(app, config) {
    if (config.acp) {
      app.addServices(new ACPService(app, config.acp));
    }
  },
  config: packageConfigSchema,
} satisfies TokenRingPlugin<typeof packageConfigSchema>;
