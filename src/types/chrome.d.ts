declare namespace chrome {
  namespace runtime {
    type MessageSender = {
      tab?: contextMenus.Tab
    }

    function openOptionsPage(): Promise<void>

    const onInstalled: {
      addListener(callback: () => void): void
    }

    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void
    }

    const lastError: {
      message?: string
    } | undefined

    function sendMessage(message: unknown, responseCallback?: (response?: unknown) => void): void
  }

  namespace i18n {
    function getMessage(messageName: string, substitutions?: string | string[]): string
  }

  namespace contextMenus {
    type ContextType = 'page' | 'selection'

    type OnClickData = {
      menuItemId: string | number
      selectionText?: string
    }

    type Tab = {
      id?: number
    }

    function create(createProperties: {
      id: string
      title: string
      contexts: ContextType[]
    }): void

    const onClicked: {
      addListener(callback: (info: OnClickData, tab?: Tab) => void): void
    }
  }

  namespace scripting {
    type InjectionTarget = {
      tabId: number
    }

    type InjectionResult<T> = {
      result?: T
    }

    function executeScript<Args extends unknown[], Result>(injection: {
      target: InjectionTarget
      func: (...args: Args) => Result
      args?: Args
    }): Promise<Array<InjectionResult<Awaited<Result>>>>
  }

  namespace storage {
    type StorageValue = string | number | boolean | null | StorageValue[] | {
      [key: string]: StorageValue
    }

    type StorageItems = Record<string, StorageValue>

    namespace sync {
      function get<T extends Record<string, unknown>>(defaults: T | null): Promise<T>
      function set(items: Record<string, unknown>): Promise<void>
    }

    namespace local {
      function get(keys: string[] | string | null): Promise<StorageItems>
      function set(items: StorageItems): Promise<void>
    }
  }
}
