import { z } from "zod"

export const NativePromptContext = z.object({
  model: z.string(),
  tools: z.array(z.string()),
  restriction: z.literal("hephaestus").optional(),
  useTaskSystem: z.boolean().optional(),
})

export type NativePromptContext = z.infer<typeof NativePromptContext>

export function frameNativePrompt(body: string, context: NativePromptContext): string {
  const encoded = JSON.stringify(context).replaceAll("<", "\\u003c")
  return `<omo-model-core>${encoded}\n${body}\n</omo-model-core>`
}

export function replaceNativePromptFrames(
  system: string[],
  model: string,
  render: (context: NativePromptContext) => string,
): void {
  for (const [index, part] of system.entries()) {
    system[index] = part.replace(
      /<omo-model-core>([^\n]+)\n[\s\S]*?<\/omo-model-core>/g,
      (frame, metadata: string) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(metadata)
        } catch (error) {
          if (error instanceof SyntaxError) return frame
          throw error
        }
        const context = NativePromptContext.safeParse(parsed)
        if (!context.success || context.data.model === model) return frame
        return render({ ...context.data, model })
      },
    )
  }
}
