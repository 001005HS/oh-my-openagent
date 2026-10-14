import type { Metadata } from "next"
import type { JSX } from "react"
import { notFound } from "next/navigation"
import { setRequestLocale, getTranslations } from "next-intl/server"

import { DownloadExperience } from "@/components/download/download-experience"
import {
  DEFAULT_DOWNLOAD_BASE_URL,
  desktopDownloadEnabled,
  fetchChannelState,
  type DesktopChannel,
} from "@/lib/desktop-download"

export const dynamic = "force-dynamic"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  if (!desktopDownloadEnabled()) return {}
  const t = await getTranslations({ locale, namespace: "download.metadata" })
  return { title: t("title"), description: t("description") }
}

export default async function DownloadPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ channel?: string | string[] }>
}): Promise<JSX.Element> {
  if (!desktopDownloadEnabled()) notFound()
  const [{ locale }, query] = await Promise.all([params, searchParams])
  setRequestLocale(locale)

  const baseUrl = process.env.DESKTOP_DOWNLOAD_BASE_URL ?? DEFAULT_DOWNLOAD_BASE_URL
  const [stable, beta] = await Promise.all([
    fetchChannelState("stable", { baseUrl }),
    fetchChannelState("beta", { baseUrl }),
  ])
  const requested: DesktopChannel =
    query.channel === "beta" && beta.status === "ready" ? "beta" : "stable"

  return <DownloadExperience channels={{ stable, beta }} initialChannel={requested} />
}
