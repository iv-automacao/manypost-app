'use client';

import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import './flow.css';
import { cn } from '@/lib/utils';
import { LayoutGrid, Maximize, Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyDeletion, dragMerge, offsetFree, shouldOpenNextStepMenu } from './canvas-logic';
import { Dock, DRAG_MIME } from './dock';
import { autoLayout } from './layout';
import {
  TRIGGER_NODE_ID,
  addNode,
  addOption,
  connect,
  createNode,
  duplicateNode,
  fieldsWritten,
  moveNode,
  removeNode,
  removeOption,
  updateNodeData,
  type BlockKind,
  type Flow,
  type NodeTexts,
  type Position,
  type Problem,
  type ShapeIssue,
  type ShapeKey,
  type TriggerConfig,
} from './logic';
import { NextStepMenu } from './next-step-menu';
import { FlowActionsContext, type FlowActions } from './actions';
import { NODE_TYPES } from './nodes';
import { TriggerPanel } from './trigger-panel';

export interface EditorDoc {
  name: string;
  flow: Flow;
  trigger: TriggerConfig;
  triggerPosition: Position;
  testUsernames: string[];
}

export function useNodeTexts(): NodeTexts {
  const t = useTranslations('automation.flow');
  // `raw`: os textos padrão levam `{nome}` literal, que o ICU interpretaria
  const r = (k: string) => t.raw(`defaults.${k}`) as string;
  return useMemo(
    () => ({
      opening: r('opening'),
      askName: r('askName'),
      thanks: r('thanks'),
      message: r('message'),
      option: r('option'),
      question: r('question'),
      end: r('end'),
      link: r('link'),
      linkButton: r('linkButton'),
      follow: r('follow'),
      followButton: r('followButton'),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );
}

interface Props {
  doc: EditorDoc;
  onChange: (doc: EditorDoc, opts?: { merge?: boolean }) => void;
  onSeal: () => void;
  readOnly: boolean;
  channelId: string;
  username: string | null;
  problems: Problem[];
  shape: ShapeIssue[];
  focus: { id: string; n: number } | null;
  onTestFrom: (nodeId: string) => void;
  texts: NodeTexts;
}

export function FlowEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({ doc, onChange, onSeal, readOnly, channelId, username, problems, shape, focus, onTestFrom, texts }: Props) {
  const t = useTranslations('automation.flow');
  const rf = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number; at: Position; from: { nodeId: string; handle: string } }>(null);
  const [triggerOpen, setTriggerOpen] = useState(false);

  // sempre a versão mais recente do documento dentro dos callbacks do React Flow
  const docRef = useRef(doc);
  docRef.current = doc;
  // todo envio passa por aqui: o ref já nasce atualizado, então callbacks no mesmo tick enxergam o doc novo
  const emit = useCallback(
    (next: EditorDoc, opts?: { merge?: boolean }) => {
      docRef.current = next;
      onChange(next, opts);
    },
    [onChange],
  );
  const setFlow = useCallback(
    (flow: Flow, opts?: { merge?: boolean }) => emit({ ...docRef.current, flow }, opts),
    [emit],
  );

  const byNode = useMemo(() => {
    const m = new Map<string, Problem[]>();
    for (const p of problems) if (p.nodeId) m.set(p.nodeId, [...(m.get(p.nodeId) ?? []), p]);
    return m;
  }, [problems]);
  const shapeByNode = useMemo(() => {
    const m = new Map<string, ShapeKey[]>();
    for (const s of shape) if (s.nodeId) m.set(s.nodeId, [...(m.get(s.nodeId) ?? []), s.key]);
    return m;
  }, [shape]);

  const derived: Node[] = useMemo(
    () => [
      {
        id: TRIGGER_NODE_ID,
        type: 'trigger',
        position: doc.triggerPosition,
        data: { trigger: doc.trigger },
        deletable: false,
        selected: selected === TRIGGER_NODE_ID,
      },
      ...doc.flow.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: { node: n },
        deletable: !readOnly && n.type !== 'opening',
        selected: selected === n.id,
      })),
    ],
    [doc.flow.nodes, doc.trigger, doc.triggerPosition, selected, readOnly],
  );
  // medidas e estado de arraste vivem em refs e entram no mesmo render (sem useEffect): o input controlado
  // recebe o valor novo na hora, sem pular o cursor. `tick` só força o render quando uma medida muda.
  const measuredRef = useRef(new Map<string, { width: number; height: number }>());
  const draggingRef = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const nodes: Node[] = useMemo(
    () =>
      derived.map((n) => ({
        ...n,
        measured: measuredRef.current.get(n.id),
        dragging: draggingRef.current.has(n.id),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [derived, tick],
  );
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const edges: Edge[] = useMemo(
    () => [
      { id: 'e-trigger', source: TRIGGER_NODE_ID, sourceHandle: 'next', target: 'opening', deletable: false, focusable: false },
      ...doc.flow.edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        deletable: !readOnly,
        selected: selectedEdge === e.id,
      })),
    ],
    [doc.flow.edges, readOnly, selectedEdge],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const cur = docRef.current;
      let flow = cur.flow;
      let triggerPosition = cur.triggerPosition;
      let moved = false;
      let dragging = false;
      let ended = false;
      let measuresChanged = false;
      for (const c of changes) {
        if (c.type === 'dimensions' && c.dimensions) {
          const old = measuredRef.current.get(c.id);
          if (!old || old.width !== c.dimensions.width || old.height !== c.dimensions.height) {
            measuredRef.current.set(c.id, { width: c.dimensions.width, height: c.dimensions.height });
            measuresChanged = true;
          }
        }
        if (c.type === 'select') setSelected((s) => (c.selected ? c.id : s === c.id ? null : s));
        if (c.type === 'position') {
          if (c.position) {
            moved = true;
            dragging ||= Boolean(c.dragging);
            if (c.id === TRIGGER_NODE_ID) triggerPosition = c.position;
            else flow = moveNode(flow, c.id, c.position);
          }
          if (c.dragging === true && !draggingRef.current.has(c.id)) {
            draggingRef.current.add(c.id);
            measuresChanged = true;
          }
          if (c.dragging === false) {
            ended = true;
            if (draggingRef.current.delete(c.id)) measuresChanged = true;
          }
        }
        // `remove` é ignorado: a exclusão pelo teclado passa toda por `onDelete` (um passo só no histórico)
      }
      if (measuresChanged) setTick((n) => n + 1);
      if (moved) emit({ ...cur, flow, triggerPosition }, { merge: dragMerge({ dragging, ended, removed: false }) });
      if (ended) onSeal();
    },
    [emit, onSeal],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // `remove` é ignorado aqui também: ver `onDelete`
      for (const c of changes) {
        if (c.type === 'select') setSelectedEdge((s) => (c.selected ? c.id : s === c.id ? null : s));
      }
    },
    [],
  );

  // exclusão pelo teclado: nós + ligações num único documento novo = 1 passo de desfazer (as ligações voltam junto)
  const onDelete = useCallback(
    ({ nodes: gone, edges: goneEdges }: { nodes: Node[]; edges: Edge[] }) => {
      const nodeIds = gone.map((n) => n.id).filter((id) => id !== TRIGGER_NODE_ID);
      const edgeIds = goneEdges.map((e) => e.id).filter((id) => id !== 'e-trigger');
      if (!nodeIds.length && !edgeIds.length) return;
      for (const id of nodeIds) measuredRef.current.delete(id);
      setFlow(applyDeletion(docRef.current.flow, nodeIds, edgeIds, ['opening']));
      setSelected((s) => (s && nodeIds.includes(s) ? null : s));
      setSelectedEdge((s) => (s && edgeIds.includes(s) ? null : s));
    },
    [setFlow],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === TRIGGER_NODE_ID) return;
      setFlow(connect(docRef.current.flow, { source: c.source, sourceHandle: c.sourceHandle ?? null, target: c.target }));
    },
    [setFlow],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const drop = {
        isValid: state.isValid,
        fromNodeId: state.fromNode?.id ?? null,
        toNode: state.toNode,
        toHandle: state.toHandle,
      };
      if (!shouldOpenNextStepMenu(drop, readOnly, TRIGGER_NODE_ID) || !state.fromNode) return;
      const point = 'changedTouches' in event ? event.changedTouches[0]! : event;
      setMenu({
        x: point.clientX,
        y: point.clientY,
        at: rf.screenToFlowPosition({ x: point.clientX, y: point.clientY }),
        from: { nodeId: state.fromNode.id, handle: state.fromHandle?.id ?? 'next' },
      });
    },
    [readOnly, rf],
  );

  const insert = useCallback(
    (kind: BlockKind, at: Position, from?: { nodeId: string; handle: string }) => {
      // sem o @ do canal o link de perfil sairia vazio
      if (kind === 'follow' && !username) return;
      const cur = docRef.current.flow;
      const taken = [...cur.nodes.map((n) => n.position), docRef.current.triggerPosition];
      const node = createNode(kind, from ? at : offsetFree(at, taken), cur, texts, username);
      let flow = addNode(cur, node);
      if (from) flow = connect(flow, { source: from.nodeId, sourceHandle: from.handle, target: node.id });
      setFlow(flow);
      setSelected(node.id);
    },
    [setFlow, texts, username],
  );

  const center = () => {
    const r = wrapper.current?.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 0) / 2, y: (r?.top ?? 0) + (r?.height ?? 0) / 2 });
  };

  // foco vindo da lista de problemas
  useEffect(() => {
    if (!focus) return;
    setSelected(focus.id);
    void rf.fitView({ nodes: [{ id: focus.id }], duration: 300, maxZoom: 1.1 });
  }, [focus, rf]);

  const organize = () => {
    const sizes = new Map(rf.getNodes().map((n) => [n.id, { width: n.measured?.width ?? 288, height: n.measured?.height ?? 160 }]));
    const r = autoLayout(docRef.current.flow, sizes);
    emit({ ...docRef.current, flow: r.flow, triggerPosition: r.triggerPosition });
    requestAnimationFrame(() => void rf.fitView({ duration: 300 }));
  };

  const actions: FlowActions = useMemo(
    () => ({
      readOnly,
      problems: byNode,
      shape: shapeByNode,
      fields: [...fieldsWritten(doc.flow)],
      update: (id, patch, opts) => setFlow(updateNodeData(docRef.current.flow, id, patch), opts),
      seal: onSeal,
      addOption: (id) => setFlow(addOption(docRef.current.flow, id, texts.option)),
      removeOption: (id, optionId) => setFlow(removeOption(docRef.current.flow, id, optionId)),
      remove: (id) => {
        setFlow(removeNode(docRef.current.flow, id));
        setSelected(null);
      },
      duplicate: (id) => {
        const r = duplicateNode(docRef.current.flow, id);
        setFlow(r.flow);
        setSelected(r.id);
      },
      testFrom: onTestFrom,
      openTrigger: () => setTriggerOpen(true),
    }),
    [readOnly, byNode, shapeByNode, doc.flow, setFlow, onSeal, texts.option, onTestFrom],
  );

  const ctrl =
    'flex size-8 items-center justify-center rounded-compact text-ink transition-colors duration-200 hover:bg-surface-2 hover:text-accent';

  return (
    <FlowActionsContext.Provider value={actions}>
      <div
        ref={wrapper}
        className="flow-canvas relative h-full w-full"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_MIME)) e.preventDefault();
        }}
        onDrop={(e) => {
          const kind = e.dataTransfer.getData(DRAG_MIME) as BlockKind;
          if (!kind) return;
          e.preventDefault();
          insert(kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onDelete={onDelete}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={(c) => c.target !== 'opening' && c.target !== TRIGGER_NODE_ID && c.source !== c.target}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
          deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
          fitView
          minZoom={0.3}
          maxZoom={1.5}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--line-strong)" />
          <Panel position="bottom-left" className="flex gap-1 rounded-control border border-line bg-surface p-1">
            <button type="button" aria-label={t('zoomIn')} title={t('zoomIn')} className={cn(ctrl, 'cursor-pointer')} onClick={() => void rf.zoomIn()}>
              <Plus className="size-4" aria-hidden />
            </button>
            <button type="button" aria-label={t('zoomOut')} title={t('zoomOut')} className={cn(ctrl, 'cursor-pointer')} onClick={() => void rf.zoomOut()}>
              <Minus className="size-4" aria-hidden />
            </button>
            <button type="button" aria-label={t('fit')} title={t('fit')} className={cn(ctrl, 'cursor-pointer')} onClick={() => void rf.fitView({ duration: 300 })}>
              <Maximize className="size-4" aria-hidden />
            </button>
            {!readOnly ? (
              <button type="button" aria-label={t('organize')} title={t('organize')} className={cn(ctrl, 'cursor-pointer')} onClick={organize}>
                <LayoutGrid className="size-4" aria-hidden />
              </button>
            ) : null}
          </Panel>
        </ReactFlow>
        {!readOnly ? <Dock followDisabled={!username} onAdd={(k) => insert(k, center())} /> : null}
        {menu ? (
          <NextStepMenu
            followDisabled={!username}
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            onPick={(k) => {
              insert(k, menu.at, menu.from);
              setMenu(null);
            }}
          />
        ) : null}
        <TriggerPanel
          open={triggerOpen}
          onOpenChange={setTriggerOpen}
          channelId={channelId}
          trigger={doc.trigger}
          testUsernames={doc.testUsernames}
          onTrigger={(trigger, opts) => emit({ ...docRef.current, trigger }, opts)}
          onTestUsernames={(testUsernames, opts) => emit({ ...docRef.current, testUsernames }, opts)}
          onSeal={onSeal}
        />
      </div>
    </FlowActionsContext.Provider>
  );
}
