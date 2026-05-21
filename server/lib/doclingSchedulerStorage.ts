import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import config from "@/config"

const resolveRoot = (rootPath = config.doclingSchedulerStorageRoot) =>
  path.isAbsolute(rootPath) ? rootPath : path.resolve(process.cwd(), rootPath)

const resolveKnowledgeBaseRoot = (
  rootPath = config.knowledgeBaseStorageRoot,
) =>
  path.isAbsolute(rootPath) ? rootPath : path.resolve(process.cwd(), rootPath)

export const getDoclingSchedulerStorageRoot = () => resolveRoot()
export const getKnowledgeBaseStorageRoot = () => resolveKnowledgeBaseRoot()

export const buildDoclingSchedulerSourceReference = (
  sourcePath: string,
  rootPath?: string,
) => {
  const knowledgeBaseRoot = resolveKnowledgeBaseRoot(rootPath)
  const absoluteSourcePath = path.isAbsolute(sourcePath)
    ? path.normalize(sourcePath)
    : path.normalize(path.resolve(knowledgeBaseRoot, sourcePath))

  if (
    absoluteSourcePath === knowledgeBaseRoot ||
    absoluteSourcePath.startsWith(knowledgeBaseRoot + path.sep)
  ) {
    const storageKey = path.relative(knowledgeBaseRoot, absoluteSourcePath)
    return {
      sourcePath: storageKey,
      sourceStorageKey: storageKey,
    }
  }

  return {
    sourcePath,
    sourceStorageKey: null,
  }
}

export const resolveDoclingSchedulerSourcePath = (
  sourcePath: string,
  sourceStorageKey?: string | null,
  rootPath?: string,
) => {
  const knowledgeBaseRoot = resolveKnowledgeBaseRoot(rootPath)
  const relativePath =
    sourceStorageKey ||
    (sourcePath && !path.isAbsolute(sourcePath) ? sourcePath : null)

  if (!relativePath) {
    return sourcePath
  }

  return path.join(knowledgeBaseRoot, relativePath)
}

export const getDoclingSchedulerStageDir = (
  fileId: string,
  runId: string,
  rootPath?: string,
) => path.join(resolveRoot(rootPath), fileId, runId)

export const getDoclingSchedulerResultsDir = (
  fileId: string,
  runId: string,
  rootPath?: string,
) => path.join(getDoclingSchedulerStageDir(fileId, runId, rootPath), "results")

export const getDoclingSchedulerResultPath = (
  fileId: string,
  runId: string,
  partIndex: number,
  rootPath?: string,
) =>
  path.join(
    getDoclingSchedulerResultsDir(fileId, runId, rootPath),
    `${String(partIndex).padStart(5, "0")}.json`,
  )

export const writeDoclingSchedulerJson = async (
  targetPath: string,
  payload: unknown,
) => {
  await mkdir(path.dirname(targetPath), { recursive: true })
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(payload)}\n`)
  await rm(targetPath, { force: true }).catch(() => undefined)
  await rename(tmpPath, targetPath)
}

export const readDoclingSchedulerJson = async <T>(
  targetPath: string,
): Promise<T> => {
  const payload = await readFile(targetPath, "utf8")
  return JSON.parse(payload) as T
}

export const cleanupDoclingSchedulerStageDir = async (
  stageDir?: string | null,
) => {
  if (!stageDir) {
    return
  }
  await rm(stageDir, { recursive: true, force: true })
}
