import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationPatch, ServerProfileInput } from '@shared/schemas';
import { invoke } from './ipc';

export const keys = {
  profiles: ['profiles'] as const,
  models: (profileId: string) => ['models', profileId] as const,
  capabilities: (profileId: string, model: string) => ['capabilities', profileId, model] as const,
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  path: (id: string) => ['messages:path', id] as const,
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
