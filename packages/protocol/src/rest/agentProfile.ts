import { z } from 'zod';

const agentNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'expected kebab-case');

export const agentProfileNameParamsSchema = z.object({ name: agentNameSchema });

export const agentProfileColorSchema = z.enum([
  'amber',
  'coral',
  'orange',
  'mint',
  'cyan',
  'blue',
  'violet',
  'pink',
]);
export type AgentProfileColor = z.infer<typeof agentProfileColorSchema>;

const agentProfileFieldsSchema = z.object({
  description: z.string().trim().min(1),
  when_to_use: z.string().trim().min(1).optional(),
  color: agentProfileColorSchema.optional(),
  tools: z.array(z.string().trim().min(1)).optional(),
  disallowed_tools: z.array(z.string().trim().min(1)).optional(),
  subagents: z.array(agentNameSchema).optional(),
  prompt: z.string().trim().min(1),
});

export const agentProfileDescriptorSchema = z.object({
  name: agentNameSchema,
  description: z.string().optional(),
  when_to_use: z.string().optional(),
  color: z.string().trim().min(1).optional(),
  source: z.enum(['builtin', 'user']),
  enabled: z.boolean(),
  editable: z.boolean(),
  model_preference: z.enum(['primary', 'secondary']).optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  subagents: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  path: z.string().optional(),
});
export type AgentProfileDescriptor = z.infer<typeof agentProfileDescriptorSchema>;

export const listAgentProfilesResponseSchema = z.object({
  items: z.array(agentProfileDescriptorSchema),
});
export type ListAgentProfilesResponse = z.infer<typeof listAgentProfilesResponseSchema>;

export const createAgentProfileRequestSchema = agentProfileFieldsSchema.extend({
  name: agentNameSchema,
  enabled: z.boolean().default(true),
});
export type CreateAgentProfileRequest = z.infer<typeof createAgentProfileRequestSchema>;

export const updateAgentProfileRequestSchema = agentProfileFieldsSchema;
export type UpdateAgentProfileRequest = z.infer<typeof updateAgentProfileRequestSchema>;

export const setAgentProfileEnabledRequestSchema = z.object({
  enabled: z.boolean(),
});
export type SetAgentProfileEnabledRequest = z.infer<typeof setAgentProfileEnabledRequestSchema>;

export const deleteAgentProfileResponseSchema = z.object({
  deleted: agentNameSchema,
});
export type DeleteAgentProfileResponse = z.infer<typeof deleteAgentProfileResponseSchema>;
