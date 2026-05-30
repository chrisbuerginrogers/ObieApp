
def plot_trf(data, file_path):
    """
    TRF File Visualization Tool
    This function takes parsed TRF data and a file path, and creates an interactive plot
    of the frequency response. The plot includes a header information box showing
    metadata from the TRF file.

    Parameters:
    - data: A dictionary containing 'header', 'columns', 'freq', 'mag', and 'warnings' from the parsed TRF file.
    - file_path: The path to the TRF file, used for the plot title.
    """
    import matplotlib.pyplot as plt

    # Format header information as text
    header_text = '\n'.join([f"{key}: {value}" for key, value in data['header'].items()])

    xlabel = data['columns'][0] if len(data['columns']) > 0 else 'Frequency'
    ylabel = data['columns'][1] if len(data['columns']) > 1 else 'Magnitude'

    # Extract frequency and magnitude
    freq = data['freq']
    mag = data['mag']

    # Create the plot with extra space on the right
    fig, ax = plt.subplots(figsize=(14, 6))
    fig.subplots_adjust(right=0.75)
    line, = ax.plot(freq, mag, 'b-', linewidth=0.5)
    ax.set(xlabel=xlabel, ylabel=ylabel, title='TRF File Plot: ' + file_path)
    ax.grid(True, alpha=0.3)

    # Add text to the right of the plot
    ax.text(1.02, 0.5, header_text, transform=ax.transAxes, fontsize=9,
            verticalalignment='center', bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5),
            family='monospace')

    plt.tight_layout()
    plt.show()

    # Print any warnings
    if data['warnings']:
        print("Warnings:")
        for warning in data['warnings']:
            print(f"  - {warning}")


def plot_trf_bands(data, band_results, file_path):
    """
    Plot a TRF with band overlays: shaded regions, average lines, and centroid markers.
    A summary table is shown in a side panel.

    Parameters
    ----------
    data         : parsed TRF dict (from parse_trf)
    band_results : list of band dicts (from compute_bands)
    file_path    : str or Path, used for the plot title
    """
    import matplotlib.pyplot as plt

    COLORS = ['#e74c3c', '#e67e22', '#2ecc71', '#3498db', '#9b59b6']

    freq   = data['freq']
    mag_db = data['mag']

    fig, ax = plt.subplots(figsize=(14, 6))
    fig.subplots_adjust(right=0.72)

    ax.plot(freq, mag_db, color='#4a90d9', linewidth=0.7, zorder=2, label='FRF')

    for i, r in enumerate(band_results):
        color = COLORS[i % len(COLORS)]
        ax.axvspan(r['f_lo'], r['f_hi'], alpha=0.18, color=color, zorder=1)
        ax.plot([r['f_lo'], r['f_hi']], [r['avg_db'], r['avg_db']],
                color=color, linewidth=2.0, zorder=3)
        ax.axvline(r['centroid'], color=color, linestyle='--', linewidth=1.2, zorder=3)
        ax.plot(r['centroid'], r['avg_db'], 'o', color=color,
                markersize=8, zorder=4, markeredgecolor='white', markeredgewidth=1.0)

    ax.set_xlabel('Frequency (Hz)')
    ax.set_ylabel('Magnitude (dB)')
    ax.set_title(f'TRF: {file_path}')
    ax.set_xscale('log')
    ax.grid(True, alpha=0.3, which='both')

    header  = f"{'Band':<14}  {'Avg':>7}  {'Centroid':>9}"
    divider = '─' * len(header)
    lines   = [header, divider]
    for r in band_results:
        lines.append(f"{r['label']:<14}  {r['avg_db']:>6.1f}dB  {r['centroid']:>7.1f}Hz")

    ax.text(1.02, 0.5, '\n'.join(lines), transform=ax.transAxes,
            fontsize=8.5, verticalalignment='center', family='monospace',
            bbox=dict(boxstyle='round', facecolor='#f5f5f5', alpha=0.9))

    plt.tight_layout()
    plt.show()