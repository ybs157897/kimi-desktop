import { Application, Container, Graphics, Sprite } from 'pixi.js';
import type { FederatedPointerEvent } from 'pixi.js';
import type { Agent, AgentState } from '#/office/vendored/types/agent';
import {
  COLORS,
  DESKS,
  INITIAL_AGENTS,
  pickHandoffVisitMessage,
  SCENE_HEIGHT,
  SCENE_WIDTH,
} from '#/office/vendored/scene/layout/officeLayout';
import { AgentEntity } from '#/office/vendored/scene/entities/AgentEntity';
import { DeskEntity } from '#/office/vendored/scene/entities/DeskEntity';
import { MovementSystem } from '#/office/vendored/scene/systems/MovementSystem';
import { AnimationSystem } from '#/office/vendored/scene/systems/AnimationSystem';
import { OfficeSimulator } from '#/office/vendored/scene/simulation/OfficeSimulator';
import { bindOfficeScene } from '#/office/vendored/scene/officeSceneBridge';
import { notifyVisitMissionActivity } from '#/office/vendored/services/officeActionDispatcher';
import { setOfficeAgents } from '#/office/vendored/store/officeStore';
import {
  getOfficeBackgroundTexture,
  loadOfficeAssets,
} from '#/office/vendored/scene/assets/loadOfficeAssets';
import { loadSpineAssets } from '#/office/vendored/scene/assets/loadSpineAssets';

export type OfficeAgentClick = {
  agent: Agent;
  rosterNo: number;
  clientX: number;
  clientY: number;
};

export class OfficeScene {
  private app: Application | null = null;
  private world: Container | null = null;
  private agentEntities = new Map<string, AgentEntity>();
  private activeAgentIds = new Set<string>();
  private deskEntities = new Map<string, DeskEntity>();
  private officeLayer: Container | null = null;

  private movement = new MovementSystem();
  private animation = new AnimationSystem();
  private simulator = new OfficeSimulator();

  private agents: Agent[] = INITIAL_AGENTS.map((a) => ({ ...a }));
  private readonly options: {
    onAgentClick?: (event: OfficeAgentClick) => void;
  };

  constructor(
    options: { onAgentClick?: (event: OfficeAgentClick) => void } = {},
  ) {
    this.options = options;
  }

  async init(
    container: HTMLElement,
    width: number,
    height: number,
    signal?: AbortSignal,
  ) {
    const app = new Application();
    await app.init({
      width,
      height,
      backgroundColor: COLORS.floor,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    if (signal?.aborted) {
      app.destroy(true, { children: true });
      return;
    }

    this.app = app;
    container.append(app.canvas);

    this.world = new Container();
    app.stage.addChild(this.world);
    this.fitStage(width, height);

    await loadSpineAssets();
    if (signal?.aborted || this.app !== app) return;
    const officeOk = await loadOfficeAssets();
    if (signal?.aborted || this.app !== app) return;
    // Missing desk/chair textures are non-fatal: the scene renders its vector
    // placeholders instead, matching the vendored office fallback behavior.
    void officeOk;

    this.drawMap(this.world);
    this.spawnOffice(this.world);
    this.pushDataToEntities();

    app.ticker.add(this.onTick);
    bindOfficeScene(this);
  }

  /** 名册序号从 1 开始：visitor 去找 host 说一句话后回座继续工作 */
  requestDeskVisit(
    visitorRosterNo: number,
    hostRosterNo: number,
    message: string,
  ) {
    this.agents = this.simulator.startDeskVisit(
      this.agents,
      visitorRosterNo,
      hostRosterNo,
      message,
    );
    this.pushDataToEntities();
  }

  /** 按顺序拜访多个工位，全部说完后回访客工位 */
  requestDeskVisitTour(
    visitorRosterNo: number,
    hostRosterNos: number[],
    messageFn?: (hostRosterNo: number, hostName: string) => string,
  ) {
    this.agents = this.simulator.startDeskVisitTour(
      this.agents,
      visitorRosterNo,
      hostRosterNos,
      messageFn ??
        ((hostNo, hostName) => pickHandoffVisitMessage(hostName, hostNo)),
    );
    this.pushDataToEntities();
  }

  getAgents(): Agent[] {
    return this.agents.map((agent) => ({ ...agent }));
  }

  setAgentState(id: string, state: AgentState, task?: string) {
    this.agents = this.agents.map((agent) => {
      if (agent.id !== id) return agent;
      return {
        ...agent,
        state,
        currentTask: task,
        targetX: undefined,
        targetY: undefined,
        walkPath: undefined,
        walkPathIndex: undefined,
        mission: undefined,
        bubbleText: undefined,
        customAnimation: undefined,
        viewFacing:
          state === 'working' || state === 'thinking'
            ? ('back' as const)
            : agent.viewFacing,
      };
    });
    setOfficeAgents(this.agents);
    this.pushDataToEntities();
  }

  /** Show only runtime agents that currently participate in the live turn. */
  setAgentPresence(id: string, present: boolean, name?: string) {
    const initial = INITIAL_AGENTS.find((agent) => agent.id === id);
    const entity = this.agentEntities.get(id);
    if (initial === undefined || entity === undefined) return;

    const wasPresent = this.activeAgentIds.has(id);
    if (present) {
      this.activeAgentIds.add(id);
      if (!wasPresent) {
        const next: Agent = {
          ...initial,
          name: name ?? initial.name,
          state: 'idle',
          currentTask: undefined,
          viewFacing: 'front',
        };
        this.agents = this.agents.map((agent) =>
          agent.id === id ? next : agent,
        );
        entity.apply(next);
        entity.setPosition(next.x, next.y);
      } else if (name !== undefined) {
        this.agents = this.agents.map((agent) =>
          agent.id === id ? { ...agent, name } : agent,
        );
        entity.apply({ name });
      }
      entity.visible = true;
      entity.eventMode = 'static';
      return;
    }

    this.activeAgentIds.delete(id);
    const reset: Agent = {
      ...initial,
      state: 'idle',
      currentTask: undefined,
      viewFacing: 'front',
    };
    this.agents = this.agents.map((agent) => (agent.id === id ? reset : agent));
    entity.hideBubble();
    entity.apply(reset);
    entity.setPosition(reset.x, reset.y);
    entity.visible = false;
    entity.eventMode = 'none';
  }

  playAgentAnimation(id: string, animation: string, task?: string) {
    this.agents = this.agents.map((agent) => {
      if (agent.id !== id) return agent;
      return {
        ...agent,
        state: 'talking' as const,
        currentTask: task,
        targetX: undefined,
        targetY: undefined,
        walkPath: undefined,
        walkPathIndex: undefined,
        mission: undefined,
        bubbleText: undefined,
        customAnimation: animation,
        viewFacing: 'front' as const,
        facing: 1 as const,
      };
    });
    setOfficeAgents(this.agents);
    this.pushDataToEntities();
    this.agentEntities.get(id)?.playCustomAnimation(animation, task);
    this.pullDataFromEntities();
    setOfficeAgents(this.agents);
  }

  resize(containerWidth: number, containerHeight: number) {
    if (!this.app || !this.world) return;
    this.app.renderer.resize(containerWidth, containerHeight);
    this.fitStage(containerWidth, containerHeight);
  }

  /** 等比缩放完整办公室场景并居中，任何屏幕比例下都不裁切内容 */
  private fitStage(containerWidth: number, containerHeight: number) {
    if (!this.world) return;

    const scale = Math.min(
      containerWidth / SCENE_WIDTH,
      containerHeight / SCENE_HEIGHT,
    );
    const offsetX = (containerWidth - SCENE_WIDTH * scale) / 2;
    const offsetY = (containerHeight - SCENE_HEIGHT * scale) / 2;

    this.world.scale.set(scale);
    this.world.position.set(offsetX, offsetY);

    const canvas = this.app?.canvas as HTMLCanvasElement | undefined;
    if (!canvas) return;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '100%';
  }

  destroy() {
    bindOfficeScene(null);
    this.app?.ticker.remove(this.onTick);
    this.app?.destroy(true, { children: true });
    this.app = null;
    this.agentEntities.clear();
    this.activeAgentIds.clear();
    this.deskEntities.clear();
    this.officeLayer = null;
  }

  private onTick = (ticker: { deltaTime: number }) => {
    const dt = Math.min(ticker.deltaTime / 60, 0.05);

    this.agents = this.simulator.tick(dt, this.agents);
    this.pushDataToEntities();

    this.movement.update(this.agentEntities, dt);
    this.pullDataFromEntities();

    this.agents = this.simulator.afterMovement(
      dt,
      this.agents,
      this.agentEntities,
    );
    this.pushDataToEntities();

    this.animation.update(this.agentEntities, dt);
    this.sortOfficeDepth();
    this.syncDeskOccupancy();

    setOfficeAgents(this.agents);
    notifyVisitMissionActivity(this.agents);
  };

  private sortOfficeDepth() {
    if (!this.officeLayer) return;

    const agentPositions = [...this.agentEntities.values()].map((e) => ({
      x: e.position.x,
      y: e.position.y,
    }));

    for (const e of this.agentEntities.values()) {
      e.zIndex = e.position.y;
    }

    for (const desk of this.deskEntities.values()) {
      desk.updateDepthZ(agentPositions);
    }

    this.officeLayer.sortChildren();
  }

  private pushDataToEntities() {
    for (const agent of this.agents) {
      const entity = this.agentEntities.get(agent.id);
      if (!entity) continue;

      const prev = entity.data;
      entity.apply(agent);
      if (
        prev.x !== agent.x ||
        prev.y !== agent.y ||
        agent.state !== 'walking'
      ) {
        entity.setPosition(agent.x, agent.y);
      }
    }
  }

  private pullDataFromEntities() {
    this.agents = this.agents.map((agent) => {
      const entity = this.agentEntities.get(agent.id);
      return entity ? { ...agent, ...entity.data } : agent;
    });
  }

  private syncDeskOccupancy() {
    const occupied = new Set(
      this.agents
        .filter((a) => a.state === 'working' && a.assignedDeskId)
        .map((a) => a.assignedDeskId!),
    );
    for (const desk of this.deskEntities.values()) {
      desk.setOccupied(occupied.has(desk.deskId));
    }
  }

  /** 桌子 / 人物 / 椅子同层；桌沿为界动态遮挡 */
  private spawnOffice(parent: Container) {
    const layer = new Container();
    layer.label = 'office';
    layer.sortableChildren = true;
    this.officeLayer = layer;

    for (const desk of DESKS) {
      const entity = new DeskEntity(desk);
      this.deskEntities.set(desk.id, entity);
      layer.addChild(
        entity.shadowGfx,
        entity.deskLayer,
        entity.chairLayer,
        entity.occupiedIndicator,
      );
    }

    for (const agent of this.agents) {
      const entity = new AgentEntity(agent);
      entity.visible = false;
      entity.eventMode = 'none';
      this.agentEntities.set(agent.id, entity);
      entity.zIndex = agent.y;
      entity.on('pointertap', (event: FederatedPointerEvent) => {
        event.stopPropagation();
        this.options.onAgentClick?.({
          agent: { ...entity.data },
          rosterNo: this.agents.findIndex((a) => a.id === agent.id) + 1,
          clientX: event.clientX,
          clientY: event.clientY,
        });
      });
      layer.addChild(entity);
    }

    this.sortOfficeDepth();
    parent.addChild(layer);
  }

  private drawMap(parent: Container) {
    const map = new Container();
    map.label = 'map';

    const floor = new Graphics();
    floor.rect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);
    floor.fill(COLORS.floor);
    map.addChild(floor);

    const bgTex = getOfficeBackgroundTexture();
    if (bgTex) {
      const bg = new Sprite(bgTex);
      const scale = Math.min(
        SCENE_WIDTH / bgTex.width,
        SCENE_HEIGHT / bgTex.height,
      );
      bg.scale.set(scale);
      bg.position.set(
        (SCENE_WIDTH - bgTex.width * scale) / 2,
        (SCENE_HEIGHT - bgTex.height * scale) / 2,
      );
      map.addChild(bg);
    }

    parent.addChildAt(map, 0);
  }
}
