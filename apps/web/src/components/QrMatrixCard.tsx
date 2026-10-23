"use client";

import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, Download, Printer } from "lucide-react";

interface QrMatrixCardProps {
  value: string;
  size?: number;
  title?: string;
  subtitle?: string;
  darkColor?: string;
  showActions?: boolean;
  onPrint?: () => void;
}

export function QrMatrixCard({
  value,
  size = 176,
  title,
  subtitle,
  darkColor = "#022c22",
  showActions = true,
  onPrint,
}: QrMatrixCardProps) {
  const [svgMarkup, setSvgMarkup] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    if (!value) {
      setSvgMarkup("");
      return;
    }
    QRCode.toString(value, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: size,
      color: {
        dark: darkColor,
        light: "#ffffff",
      },
    })
      .then((svg) => {
        if (active) setSvgMarkup(svg);
      })
      .catch(() => {
        if (active) setSvgMarkup("");
      });
    return () => {
      active = false;
    };
  }, [value, size, darkColor]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard permission errors in restricted contexts
    }
  };

  const handleDownloadSvg = () => {
    if (!svgMarkup) return;
    const blob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kabadiwala-qr-${Date.now()}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col items-center rounded-2xl border border-slate-200 bg-white p-4 text-center shadow-sm">
      {title && <div className="text-xs font-extrabold text-slate-900">{title}</div>}
      {subtitle && (
        <div className="mt-0.5 text-[11px] text-slate-500">{subtitle}</div>
      )}

      <div
        className="mt-2.5 flex items-center justify-center rounded-xl border border-slate-100 bg-white p-2 shadow-inner"
        style={{ minWidth: size + 16, minHeight: size + 16 }}
      >
        {svgMarkup ? (
          <div
            aria-label={`Scannable QR Code for ${title ?? value}`}
            dangerouslySetInnerHTML={{ __html: svgMarkup }}
          />
        ) : (
          <div className="text-[11px] font-medium text-slate-400">
            Encoding ISO 18004 QR...
          </div>
        )}
      </div>

      {showActions && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 print:hidden">
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-100"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-600" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" /> Copy Link
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleDownloadSvg}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-100"
          >
            <Download className="h-3 w-3" /> Sticker SVG
          </button>

          {onPrint && (
            <button
              type="button"
              onClick={onPrint}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-800 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-900"
            >
              <Printer className="h-3 w-3" /> Print Sticker
            </button>
          )}
        </div>
      )}
    </div>
  );
}
