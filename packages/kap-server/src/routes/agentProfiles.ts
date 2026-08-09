/**
 * `/agent-profiles` routes — list builtin and user subagent profiles and
 * manage user-level agent Markdown files through the core user-profile store.
 */

import {
  AGENT_MODELS_SECTION,
  DEFAULT_AGENT_PROFILE_NAME,
  IBuiltinAgentProfileLoader,
  IConfigService,
  IUserAgentProfileLoader,
  IUserAgentProfileStore,
  IWorkspaceLifecycleService,
  type AgentModelsConfig,
  type Scope,
  type UserAgentProfileRecord,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  agentProfileDescriptorSchema,
  agentProfileNameParamsSchema,
  createAgentProfileRequestSchema,
  deleteAgentProfileResponseSchema,
  listAgentProfilesResponseSchema,
  setAgentProfileEnabledRequestSchema,
  updateAgentProfileRequestSchema,
  type AgentProfileDescriptor,
} from '../protocol/rest-agentProfile';

interface AgentProfilesRouteHost {
  get(
    path: string,
    options: object,
    handler: (req: { id: string }, reply: AgentProfilesReply) => unknown,
  ): unknown;
  post(
    path: string,
    options: object,
    handler: (
      req: { id: string; body: unknown; params: Record<string, string> },
      reply: AgentProfilesReply,
    ) => unknown,
  ): unknown;
  put(
    path: string,
    options: object,
    handler: (
      req: { id: string; body: unknown; params: Record<string, string> },
      reply: AgentProfilesReply,
    ) => unknown,
  ): unknown;
  delete(
    path: string,
    options: object,
    handler: (
      req: { id: string; params: Record<string, string> },
      reply: AgentProfilesReply,
    ) => unknown,
  ): unknown;
}

interface AgentProfilesReply {
  send(payload: unknown): unknown;
}

export function registerAgentProfilesRoute(app: AgentProfilesRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/agent-profiles',
      success: { data: listAgentProfilesResponseSchema },
      description: 'List builtin and user subagent profiles',
      tags: ['agents'],
    },
    async (req, reply) => {
      const builtin = core.accessor
        .get(IBuiltinAgentProfileLoader)
        .list()
        .filter((profile) => profile.name !== DEFAULT_AGENT_PROFILE_NAME)
        .map<AgentProfileDescriptor>((profile) => ({
          name: profile.name,
          description: profile.description,
          when_to_use: profile.whenToUse,
          source: 'builtin',
          enabled: true,
          editable: false,
          model_preference: profile.modelPreference,
          tools: profile.tools === undefined ? undefined : [...profile.tools],
        }));
      const user = (await core.accessor.get(IUserAgentProfileStore).list()).map(toDescriptor);
      reply.send(
        okEnvelope(
          { items: [...user, ...builtin].toSorted((a, b) => a.name.localeCompare(b.name)) },
          req.id,
        ),
      );
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<AgentProfilesRouteHost['get']>[2],
  );

  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/agent-profiles',
      body: createAgentProfileRequestSchema,
      success: { data: agentProfileDescriptorSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Create a user subagent profile',
      tags: ['agents'],
    },
    async (req, reply) => {
      try {
        const profile = await core.accessor.get(IUserAgentProfileStore).create({
          name: req.body.name,
          description: req.body.description,
          whenToUse: req.body.when_to_use,
          color: req.body.color,
          tools: req.body.tools,
          disallowedTools: req.body.disallowed_tools,
          subagents: req.body.subagents,
          prompt: req.body.prompt,
          enabled: req.body.enabled,
        });
        await reloadUserProfiles(core);
        reply.send(okEnvelope(toDescriptor(profile), req.id));
      } catch (error) {
        sendValidationError(reply, req.id, error);
      }
    },
  );
  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<AgentProfilesRouteHost['post']>[2],
  );

  const updateRoute = defineRoute(
    {
      method: 'PUT',
      path: '/agent-profiles/{name}',
      params: agentProfileNameParamsSchema,
      body: updateAgentProfileRequestSchema,
      success: { data: agentProfileDescriptorSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Replace editable fields of a user subagent profile',
      tags: ['agents'],
    },
    async (req, reply) => {
      try {
        const profile = await core.accessor.get(IUserAgentProfileStore).replace(req.params.name, {
          description: req.body.description,
          whenToUse: req.body.when_to_use,
          color: req.body.color,
          tools: req.body.tools,
          disallowedTools: req.body.disallowed_tools,
          subagents: req.body.subagents,
          prompt: req.body.prompt,
        });
        await reloadUserProfiles(core);
        reply.send(okEnvelope(toDescriptor(profile), req.id));
      } catch (error) {
        sendValidationError(reply, req.id, error);
      }
    },
  );
  app.put(
    updateRoute.path,
    updateRoute.options,
    updateRoute.handler as Parameters<AgentProfilesRouteHost['put']>[2],
  );

  const stateRoute = defineRoute(
    {
      method: 'POST',
      path: '/agent-profiles/{name}/state',
      params: agentProfileNameParamsSchema,
      body: setAgentProfileEnabledRequestSchema,
      success: { data: agentProfileDescriptorSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Enable or disable a user subagent profile',
      tags: ['agents'],
    },
    async (req, reply) => {
      try {
        const profile = await core.accessor
          .get(IUserAgentProfileStore)
          .setEnabled(req.params.name, req.body.enabled);
        await reloadUserProfiles(core);
        reply.send(okEnvelope(toDescriptor(profile), req.id));
      } catch (error) {
        sendValidationError(reply, req.id, error);
      }
    },
  );
  app.post(
    stateRoute.path,
    stateRoute.options,
    stateRoute.handler as Parameters<AgentProfilesRouteHost['post']>[2],
  );

  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/agent-profiles/{name}',
      params: agentProfileNameParamsSchema,
      success: { data: deleteAgentProfileResponseSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Delete a user subagent profile',
      tags: ['agents'],
    },
    async (req, reply) => {
      try {
        await core.accessor.get(IUserAgentProfileStore).remove(req.params.name);
        await removeAgentModelBinding(core, req.params.name);
        await reloadUserProfiles(core);
        reply.send(okEnvelope({ deleted: req.params.name }, req.id));
      } catch (error) {
        sendValidationError(reply, req.id, error);
      }
    },
  );
  app.delete(
    deleteRoute.path,
    deleteRoute.options,
    deleteRoute.handler as Parameters<AgentProfilesRouteHost['delete']>[2],
  );
}

function toDescriptor(profile: UserAgentProfileRecord): AgentProfileDescriptor {
  return {
    name: profile.name,
    description: profile.description,
    when_to_use: profile.whenToUse,
    color: profile.color,
    source: 'user',
    enabled: profile.enabled,
    editable: profile.editable,
    tools: profile.tools === undefined ? undefined : [...profile.tools],
    disallowed_tools:
      profile.disallowedTools === undefined ? undefined : [...profile.disallowedTools],
    subagents: profile.subagents === undefined ? undefined : [...profile.subagents],
    prompt: profile.prompt,
    path: profile.path,
  };
}

async function reloadUserProfiles(core: Scope): Promise<void> {
  await Promise.all(
    core.accessor
      .get(IWorkspaceLifecycleService)
      .handlers.list()
      .map((handler) => handler.accessor.get(IUserAgentProfileLoader).reload()),
  );
}

async function removeAgentModelBinding(core: Scope, name: string): Promise<void> {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  const current = config.get<AgentModelsConfig | undefined>(AGENT_MODELS_SECTION) ?? {};
  if (current[name] === undefined) return;
  const next = { ...current };
  delete next[name];
  await config.replace(AGENT_MODELS_SECTION, next);
}

function sendValidationError(
  reply: AgentProfilesReply,
  requestId: string,
  error: unknown,
): void {
  reply.send(
    errEnvelope(
      ErrorCode.VALIDATION_FAILED,
      error instanceof Error ? error.message : String(error),
      requestId,
    ),
  );
}
