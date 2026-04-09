type DisposeOptions = {
  soft?: boolean
}

const disposers = new Set<(directory: string, options?: DisposeOptions) => Promise<void>>()

export function registerDisposer(disposer: (directory: string, options?: DisposeOptions) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string, options?: DisposeOptions) {
  await Promise.allSettled([...disposers].map((disposer) => disposer(directory, options)))
}
