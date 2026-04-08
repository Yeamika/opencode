#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"

const args = process.argv.slice(2)

function take(flag, fallback) {
  const index = args.indexOf(flag)
  if (index === -1) return fallback
  return args[index + 1]
}

const artifactDir = path.resolve(take("--path", take("--artifact-dir", process.cwd())))
const registry = take("--registry", process.env.LOCAL_NPM_REGISTRY || "http://desktop-phi:4873/")
const tag = take("--tag", process.env.LOCAL_NPM_TAG || "local-yes-latest")
const extraTags = (take("--extra-tags", process.env.LOCAL_NPM_EXTRA_TAGS || "latest") || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
const version = take("--version", process.env.LOCAL_NPM_VERSION || "")
const dryRun = args.includes("--dry-run")

const ignore = new Set(["node_modules", ".git"])

async function walk(dir) {
  const out = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (ignore.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walk(full)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".tgz")) out.push(full)
  }
  return out
}

function orderScore(file) {
  const name = path.basename(file)
  if (/^opencode-windows-x64-/.test(name)) return 10
  if (/^opencode-linux-x64-/.test(name)) return 20
  if (/^opencode-linux-arm64-/.test(name)) return 30
  if (/^opencode-ai-/.test(name) && !/^opencode-ai-(sdk|plugin)-/.test(name)) return 40
  if (/^opencode-ai-sdk-/.test(name)) return 50
  if (/^opencode-ai-plugin-/.test(name)) return 60
  return 100
}

function runNpm(commandArgs) {
  const result = spawnSync("npm", commandArgs, {
    cwd: artifactDir,
    encoding: "utf8",
    shell: process.platform === "win32",
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  }
}

function alreadyPublished(output) {
  return [
    /cannot publish over existing version/i,
    /previously published/i,
    /EPUBLISHCONFLICT/i,
    /forbidden.*pre-existing version/i,
    /cannot modify pre-existing version/i,
    /already present/i,
  ].some((pattern) => pattern.test(output))
}

function addDistTag(spec, distTag) {
  const result = runNpm(["dist-tag", "add", spec, distTag, "--registry", registry])
  const combined = `${result.stdout}\n${result.stderr}`
  if (result.status === 0) return { ok: true }
  if (alreadyPublished(combined)) return { ok: true, skipped: true }
  return { ok: false, output: combined }
}

function readPackageInfo(file) {
  const base = path.basename(file)
  const mappings = [
    { prefix: "opencode-ai-sdk-", name: "@opencode-ai/sdk" },
    { prefix: "opencode-ai-plugin-", name: "@opencode-ai/plugin" },
    { prefix: "opencode-ai-", name: "opencode-ai" },
    { prefix: "opencode-windows-x64-", name: "opencode-windows-x64" },
    { prefix: "opencode-linux-x64-", name: "opencode-linux-x64" },
    { prefix: "opencode-linux-arm64-", name: "opencode-linux-arm64" },
  ]
  for (const item of mappings) {
    if (base.startsWith(item.prefix) && base.endsWith(".tgz")) {
      return {
        name: item.name,
        version: base.slice(item.prefix.length, -4),
      }
    }
  }
  throw new Error(`Failed to infer package metadata from file name: ${base}`)
}

const allFiles = (await walk(artifactDir)).sort((a, b) => {
  const diff = orderScore(a) - orderScore(b)
  if (diff !== 0) return diff
  return a.localeCompare(b)
})

const seenFiles = new Set()
const files = []
for (const file of allFiles) {
  const key = path.basename(file)
  if (seenFiles.has(key)) continue
  if (version && !key.includes(version)) continue
  seenFiles.add(key)
  files.push(file)
}

if (files.length === 0) {
  console.error(`No .tgz packages found under ${artifactDir}`)
  process.exit(1)
}

console.log(`Publishing ${files.length} package(s) from ${artifactDir}`)
console.log(`Registry: ${registry}`)
if (tag) console.log(`Tag: ${tag}`)
if (version) console.log(`Version filter: ${version}`)
if (dryRun) console.log(`Mode: dry-run`)

let published = 0
let skipped = 0
let failed = 0

for (const file of files) {
  const rel = path.relative(artifactDir, file)
  const cmd = ["publish", file, "--registry", registry]
  if (tag) cmd.push("--tag", tag)

  if (dryRun) {
    console.log(`[dry-run] npm ${cmd.join(" ")}`)
    continue
  }

  const result = runNpm(cmd)
  const combined = `${result.stdout}\n${result.stderr}`
  if (result.status === 0) {
    published += 1
    console.log(`[published] ${rel}`)
    const pkg = await readPackageInfo(file)
    for (const distTag of extraTags) {
      const tagResult = addDistTag(`${pkg.name}@${pkg.version}`, distTag)
      if (!tagResult.ok) {
        failed += 1
        console.error(`[failed-tag] ${rel} -> ${distTag}`)
        console.error((tagResult.output || "").trim())
      } else {
        console.log(`[tagged] ${pkg.name}@${pkg.version} -> ${distTag}`)
      }
    }
    continue
  }

  if (alreadyPublished(combined)) {
    skipped += 1
    console.log(`[skipped] ${rel} (already published)`)
    continue
  }

  failed += 1
  console.error(`[failed] ${rel}`)
  console.error(combined.trim())
}

console.log(`Summary: published=${published} skipped=${skipped} failed=${failed}`)
if (failed > 0) process.exit(1)
