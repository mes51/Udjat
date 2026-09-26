import { create } from 'zustand';

interface UiStore {
  selectedConversationId: string | null;
  select: (id: string | null) => void;
  profilesDialogOpen: boolean;
  setProfilesDialogOpen: (open: boolean) => void;
  conversationSettingsOpen: boolean;
  setConversationSettingsOpen: (open: boolean) => void;
  /** 検索結果などから飛んだ時に、表示後スクロールして強調するメッセージ */
  scrollTarget: { conversationId: string; messageId: string } | null;
  setScrollTarget: (t: { conversationId: string; messageId: string } | null) => void;
}

function readSelected(): string | null {
  try {
    return localStorage.getItem('udjat.selectedConversation');
  } catch {
    return null;
  }
}

export const useUiStore = create<UiStore>((set) => ({
  selectedConversationId: readSelected(),
  select: (id) => {
    try {
      if (id) localStorage.setItem('udjat.selectedConversation', id);
      else localStorage.removeItem('udjat.selectedConversation');
    } catch {
      /* ignore */
    }
    set({ selectedConversationId: id });
  },
  profilesDialogOpen: false,
  setProfilesDialogOpen: (open) => set({ profilesDialogOpen: open }),
  conversationSettingsOpen: false,
  setConversationSettingsOpen: (open) => set({ conversationSettingsOpen: open }),
  scrollTarget: null,
  setScrollTarget: (t) => set({ scrollTarget: t }),
}));
