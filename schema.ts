import { z } from "zod";

export const ACPConfigSchema = z.object({
  transport: z.literal("stdio").default("stdio"),
  defaultAgentType: z.string().exactOptional(),
});

export type ACPConfig = z.output<typeof ACPConfigSchema>;
