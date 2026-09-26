import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ConversationPatch, ServerProfileInput, ToolPolicy } from '@shared/schemas';
import { invoke } from './ipc';

export const keys = {
  profiles: ['profiles'] as const,
  models: (profileId: string) => ['models', profileId] as const,
  capabilities: (profileId: string, model: string) => ['capabilities', profileId, model] as const,
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  path: (id: string) => ['messages:path', id] as const,
  branches: (id: string) => ['messages:branches', id] as const,
  search: (q: string) => ['messages:search', q] as const,
  tools: ['tools'] as const,
  setting: (key: string) => ['setting', key] as const,
};

export function useProfiles() {
  return useQuery({ queryKey: keys.profiles, queryFn: () => invoke('profiles:list') });
}

export function useModels(profileId: string | null) {
  return useQuery({
    queryKey: keys.models(profileId ?? ''),
    queryFn: () => invoke('profiles:models', { profileId: profileId! }),
    enabled: !!profileId,
    staleTime: 60_000,
    retry: 0,
  });
}

export function useCapabilities(profileId: string | null, model: string | null) {
  return useQuery({
    queryKey: keys.capabilities(profileId ?? '', model ?? ''),
    queryFn: () => invoke('models:capabilities', { profileId: profileId!, model: model! }),
    enabled: !!profileId && !!model,
    staleTime: 5 * 60_000,
    retry: 0,
  });
}

export function useConversations() {
  return useQuery({ queryKey: keys.conversations, queryFn: () => invoke('conversations:list') });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: keys.conversation(id ?? ''),
    queryFn: () => invoke('conversations:get', { id: id! }),
    enabled: !!id,
  });
}

export function useMessagePath(conversationId: string | null) {
  return useQuery({
    queryKey: keys.path(conversationId ?? ''),
    queryFn: () => invoke('messages:path', { conversationId: conversationId! }),
    enabled: !!conversationId,
  });
}

export function useBranches(conversationId: string | null) {
  return useQuery({
    queryKey: keys.branches(conversationId ?? ''),
    queryFn: () => invoke('messages:branches', { conversationId: conversationId! }),
    enabled: !!conversationId,
  });
}

export function useSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: keys.search(q),
    queryFn: () => invoke('messages:search', { query: q, limit: 100 }),
    enabled: q.length > 0,
    staleTime: 10_000,
  });
}

/** path と分岐情報をまとめて再取得する */
export function invalidateConversationView(qc: QueryClient, conversationId: string): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.path(conversationId) }),
    qc.invalidateQueries({ queryKey: keys.branches(conversationId) }),
  ]).then(() => undefined);
}

export function useTools() {
  return useQuery({ queryKey: keys.tools, queryFn: () => invoke('tools:list') });
}

export function useToolPolicyMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; policy: ToolPolicy | null }) => invoke('tools:setPolicy', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.tools }),
  });
}

export function useSetting<T = unknown>(key: string) {
  return useQuery({
    queryKey: keys.setting(key),
    queryFn: async () => (await invoke('settings:get', { key })) as T | null,
  });
}

export function useSettingMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { key: string; value: unknown }) => invoke('settings:set', v),
    onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: keys.setting(v.key) }),
  });
}

export function useProfileMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: keys.profiles });
  const create = useMutation({
    mutationFn: (input: ServerProfileInput) => invoke('profiles:create', input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; patch: Partial<ServerProfileInput> }) =>
      invoke('profiles:update', v),
    onSuccess: () => {
      void invalidate();
      void qc.invalidateQueries({ queryKey: ['models'] });
      void qc.invalidateQueries({ queryKey: ['capabilities'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => invoke('profiles:delete', { id }),
    onSuccess: () => {
      void invalidate();
      void qc.invalidateQueries({ queryKey: keys.conversations });
    },
  });
  return { create, update, remove };
}

export function useConversationMutations() {
  const qc = useQueryClient();
  // onSuccess が Promise を返すと、mutate() 側のコールバックは一覧の再取得後に呼ばれる
  const create = useMutation({
    mutationFn: (v: { serverProfileId: string | null; model: string | null }) =>
      invoke('conversations:create', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.conversations }),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; patch: ConversationPatch }) => invoke('conversations:update', v),
    onSuccess: (conv) => {
      qc.setQueryData(keys.conversation(conv.id), conv);
      void qc.invalidateQueries({ queryKey: keys.conversations });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => invoke('conversations:delete', { id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.conversations }),
  });
  return { create, update, remove };
}
