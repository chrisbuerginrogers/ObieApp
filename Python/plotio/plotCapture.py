import numpy as np
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
from dataclasses import dataclass

COLORS        = ["#ff4444", "#4488ff"]
MINMAX_COLORS = ["#cc2222", "#2266cc"]
LABELS        = ["Ch 1 — Hammer", "Ch 2 — Microphone"]

BG = "#0d1117"


@dataclass
class CapturePlot:
    fig:        plt.Figure
    axes:       list           # [ch1, ch2, frf, coherence]
    lines:      list           # time-domain lines [ch1, ch2]
    hlines_pos: list
    hlines_neg: list
    frf_line:   object         # plt.Line2D
    coh_line:   object         # plt.Line2D
    info_text:  plt.Text
    sample_rate: int
    freq_min:   float
    freq_max:   float


def init_capture_plot(sample_rate: int, freq_min: float = 200.0, freq_max: float = 7000.0) -> CapturePlot:
    """Create the four-panel figure once before the capture loop."""
    plt.ion()
    fig = plt.figure(figsize=(13, 9))
    fig.patch.set_facecolor(BG)
    fig.subplots_adjust(right=0.78, hspace=0.45)
    fig.suptitle("Triggered Capture", color="#ffffff", fontsize=13)

    gs = gridspec.GridSpec(4, 1, figure=fig)
    ax_ch1 = fig.add_subplot(gs[0])
    ax_ch2 = fig.add_subplot(gs[1], sharex=ax_ch1)
    ax_frf = fig.add_subplot(gs[2])
    ax_coh = fig.add_subplot(gs[3], sharex=ax_frf)
    axes = [ax_ch1, ax_ch2, ax_frf, ax_coh]

    # ── Time-domain panels ────────────────────────────────────────────────────
    lines, hlines_pos, hlines_neg = [], [], []
    for i, ax in enumerate(axes[:2]):
        ax.set_facecolor(BG)
        ln, = ax.plot([], [], color=COLORS[i], linewidth=0.8)
        lines.append(ln)
        hp = ax.axhline(0, color=MINMAX_COLORS[i], linewidth=0.8, linestyle="--", alpha=0.7)
        hn = ax.axhline(0, color=MINMAX_COLORS[i], linewidth=0.8, linestyle="--", alpha=0.7)
        hlines_pos.append(hp)
        hlines_neg.append(hn)
        ax.set_ylabel(LABELS[i], color=COLORS[i], fontsize=9)
        ax.tick_params(colors="#aaaaaa")
        for spine in ax.spines.values():
            spine.set_edgecolor("#333333")

    ax_ch2.set_xlabel("Time (ms)", color="#aaaaaa")

    # ── FRF panel ─────────────────────────────────────────────────────────────
    ax_frf.set_facecolor(BG)
    frf_line, = ax_frf.plot([], [], color="#44dd88", linewidth=0.9)
    ax_frf.set_ylabel("FRF (dB)", color="#44dd88", fontsize=9)
    ax_frf.set_xscale("log")
    ax_frf.set_xlim(freq_min, freq_max)
    ax_frf.tick_params(colors="#aaaaaa")
    ax_frf.xaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f"{int(x)}"))
    for spine in ax_frf.spines.values():
        spine.set_edgecolor("#333333")

    # ── Coherence panel ───────────────────────────────────────────────────────
    ax_coh.set_facecolor(BG)
    coh_line, = ax_coh.plot([], [], color="#ffaa33", linewidth=0.9)
    ax_coh.set_ylabel("Coherence", color="#ffaa33", fontsize=9)
    ax_coh.set_xlabel("Frequency (Hz)", color="#aaaaaa")
    ax_coh.set_xscale("log")
    ax_coh.set_xlim(freq_min, freq_max)
    ax_coh.set_ylim(0, 1.05)
    ax_coh.axhline(1.0, color="#555555", linewidth=0.6, linestyle="--")
    ax_coh.tick_params(colors="#aaaaaa")
    ax_coh.xaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f"{int(x)}"))
    for spine in ax_coh.spines.values():
        spine.set_edgecolor("#333333")

    # ── Info text (right margin) ───────────────────────────────────────────────
    info_text = fig.text(
        0.80, 0.5, "",
        transform=fig.transFigure,
        fontsize=9, verticalalignment="center", family="monospace", color="#dddddd",
        bbox=dict(boxstyle="round", facecolor="#1a1f2b", edgecolor="#444444", alpha=0.9),
    )

    plt.pause(0.001)
    return CapturePlot(fig, axes, lines, hlines_pos, hlines_neg,
                       frf_line, coh_line, info_text, sample_rate, freq_min, freq_max)


def update_capture_plot(
    plot:      CapturePlot,
    data:      np.ndarray,
    hit:       int = 1,
    freqs:     np.ndarray | None = None,
    H_dB:      np.ndarray | None = None,
    coherence: np.ndarray | None = None,
) -> None:
    """Update all four panels — non-blocking."""
    n        = len(data)
    t_ms     = np.arange(n) / plot.sample_rate * 1000
    peaks    = [float(np.max(np.abs(data[:, ch]))) for ch in range(2)]
    duration = n / plot.sample_rate * 1000

    # Time-domain
    for i, ax in enumerate(plot.axes[:2]):
        plot.lines[i].set_data(t_ms, data[:, i])
        plot.hlines_pos[i].set_ydata([peaks[i],  peaks[i]])
        plot.hlines_neg[i].set_ydata([-peaks[i], -peaks[i]])
        ax.set_xlim(0, t_ms[-1])
        ax.relim()
        ax.autoscale_view(scalex=False)

    # FRF
    if freqs is not None and H_dB is not None:
        ax_frf = plot.axes[2]
        plot.frf_line.set_data(freqs, H_dB)
        ax_frf.set_xlim(plot.freq_min, plot.freq_max)
        ax_frf.relim()
        ax_frf.autoscale_view(scalex=False)

    # Coherence
    if freqs is not None and coherence is not None:
        ax_coh = plot.axes[3]
        plot.coh_line.set_data(freqs, coherence)
        ax_coh.set_xlim(plot.freq_min, plot.freq_max)

    # Compute n_avg from FRF accumulator hit count (passed as hit)
    frf_label = f"FRF avg:   {hit} hit{'s' if hit != 1 else ''}"

    plot.info_text.set_text(
        f"Hit:       {hit}\n"
        f"Samples:   {n}\n"
        f"Duration:  {duration:.1f} ms\n"
        f"\n"
        f"Ch1 peak:  {peaks[0]:.4f}\n"
        f"Ch2 peak:  {peaks[1]:.4f}\n"
        f"\n"
        f"{frf_label}"
    )
    plot.fig.canvas.draw()
    plt.pause(0.001)


def keep_capture_plot_open() -> None:
    """Block until the user closes the plot window."""
    plt.ioff()
    plt.show(block=True)
