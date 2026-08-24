const FOLLOW_BOTTOM_THRESHOLD = 24;
const PROGRAMMATIC_SCROLL_TOLERANCE = 1;

type ScrollContainer = Pick<
  HTMLElement,
  'clientHeight' | 'scrollHeight' | 'scrollTop'
>;

export interface MessageScrollPosition {
  scrollTop: number;
  stickToBottom: boolean;
}

const DEFAULT_SCROLL_POSITION: MessageScrollPosition = {
  scrollTop: 0,
  stickToBottom: true,
};

export class MessageScrollPositionStore {
  private activeKey: string | null = null;
  private activeContainer: ScrollContainer | null = null;
  private expectedProgrammaticScrollTop: number | null = null;
  private readonly positions = new Map<string, MessageScrollPosition>();

  prepareForRender(
    nextKey: string | null,
    currentContainer: ScrollContainer | null,
  ): MessageScrollPosition {
    if (this.activeKey && currentContainer) {
      const captured = captureMessageScrollPosition(currentContainer);
      const previous = this.positions.get(this.activeKey);
      // Manual scrolling remains authoritative until the user reaches the bottom.
      if (previous?.stickToBottom === false) {
        const movedDown = currentContainer.scrollTop > (
          previous.scrollTop + PROGRAMMATIC_SCROLL_TOLERANCE
        );
        captured.stickToBottom = movedDown && (
          distanceFromBottom(currentContainer) <= FOLLOW_BOTTOM_THRESHOLD
        );
      }
      this.positions.set(
        this.activeKey,
        captured,
      );
    }
    this.activeKey = nextKey;
    this.activeContainer = null;
    this.expectedProgrammaticScrollTop = null;
    const position = nextKey
      ? this.positions.get(nextKey) ?? { ...DEFAULT_SCROLL_POSITION }
      : { ...DEFAULT_SCROLL_POSITION };
    if (nextKey) {
      this.positions.set(nextKey, position);
    }
    return { ...position };
  }

  trackActiveContainer(
    key: string | null,
    container: ScrollContainer,
  ): void {
    if (key === this.activeKey) {
      this.activeContainer = container;
      this.expectedProgrammaticScrollTop = null;
    }
  }

  restoreActivePosition(
    key: string | null,
    container: ScrollContainer,
    position: MessageScrollPosition,
  ): void {
    restoreMessageScrollPosition(container, position);
    if (
      key
      && key === this.activeKey
      && container === this.activeContainer
    ) {
      this.positions.set(key, {
        scrollTop: container.scrollTop,
        stickToBottom: position.stickToBottom,
      });
      this.expectedProgrammaticScrollTop = container.scrollTop;
    }
  }

  recordActiveScroll(
    key: string | null,
    container: ScrollContainer,
  ): void {
    if (
      !key
      || key !== this.activeKey
      || container !== this.activeContainer
    ) {
      return;
    }
    if (
      this.expectedProgrammaticScrollTop !== null
      && Math.abs(
        container.scrollTop - this.expectedProgrammaticScrollTop,
      ) <= PROGRAMMATIC_SCROLL_TOLERANCE
    ) {
      this.expectedProgrammaticScrollTop = null;
      return;
    }
    this.expectedProgrammaticScrollTop = null;
    const previousPosition = this.positions.get(key);
    const movedUp = previousPosition
      && container.scrollTop < (
        previousPosition.scrollTop - PROGRAMMATIC_SCROLL_TOLERANCE
      );
    this.positions.set(key, {
      scrollTop: container.scrollTop,
      stickToBottom: !movedUp
        && distanceFromBottom(container) <= FOLLOW_BOTTOM_THRESHOLD,
    });
  }

  pauseActiveFollowing(
    key: string | null,
    container: ScrollContainer,
  ): void {
    if (
      !key
      || key !== this.activeKey
      || container !== this.activeContainer
    ) {
      return;
    }
    this.expectedProgrammaticScrollTop = null;
    this.positions.set(key, {
      scrollTop: container.scrollTop,
      stickToBottom: false,
    });
  }

  resumeActiveFollowing(
    key: string | null,
    container: ScrollContainer,
  ): void {
    if (
      !key
      || key !== this.activeKey
      || container !== this.activeContainer
    ) {
      return;
    }
    const position = {
      scrollTop: container.scrollTop,
      stickToBottom: true,
    };
    this.positions.set(key, position);
    this.restoreActivePosition(key, container, position);
  }

  isFollowing(key: string | null): boolean {
    if (!key || key !== this.activeKey) {
      return true;
    }
    return (this.positions.get(key) ?? DEFAULT_SCROLL_POSITION).stickToBottom;
  }

  getPosition(key: string | null): MessageScrollPosition {
    if (!key || key !== this.activeKey) {
      return { ...DEFAULT_SCROLL_POSITION };
    }
    return {
      ...(this.positions.get(key) ?? DEFAULT_SCROLL_POSITION),
    };
  }
}

export function captureMessageScrollPosition(
  container: ScrollContainer | null,
): MessageScrollPosition {
  if (!container) {
    return { ...DEFAULT_SCROLL_POSITION };
  }

  return {
    scrollTop: container.scrollTop,
    stickToBottom: distanceFromBottom(container) <= FOLLOW_BOTTOM_THRESHOLD,
  };
}

export function restoreMessageScrollPosition(
  container: ScrollContainer,
  position: MessageScrollPosition,
): void {
  container.scrollTop = position.stickToBottom
    ? container.scrollHeight
    : position.scrollTop;
}

function distanceFromBottom(container: ScrollContainer): number {
  return container.scrollHeight
    - container.scrollTop
    - container.clientHeight;
}
