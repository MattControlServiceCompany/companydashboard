var SharedCharts = (function () {
  var _chartInstances = {};

  var DEFAULT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var YR_PALETTE = {
    kwh: ['#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a8a'],
    kw: ['#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a8a'],
    gas: ['#fed7aa', '#f97316', '#c2410c', '#7c2d12'],
    propane: ['#fde68a', '#f59e0b', '#b45309', '#78350f'],
    water: ['#86efac', '#22c55e', '#15803d', '#14532d'],
    cost: ['#c4b5fd', '#8b5cf6', '#6d28d9', '#4c1d95'],
  };
  var BL_LINE_COLOR = 'rgba(168,85,247,0.9)';

  function renderYearOverYearChart(canvasId, data, options) {
    options = options || {};
    var canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    if (_chartInstances[canvasId]) {
      _chartInstances[canvasId].destroy();
    }

    var field = data.field;
    var unit = data.unit;
    var yearData = data.yearData;
    var yrsToShow = data.yrsToShow;
    var blAvgArr = data.blAvgArr;
    var palette = YR_PALETTE[field] || YR_PALETTE['kwh'];

    var datasets = [];
    yrsToShow.forEach(function (y, i) {
      var paletteIdx = Math.max(0, palette.length - 1 - i);
      var barColor = palette[paletteIdx] || palette[0];
      datasets.push({
        label: '' + y,
        data: DEFAULT_MONTHS.map(function (_, mi) {
          return (yearData[y] && yearData[y][field] && yearData[y][field][mi]) || 0;
        }),
        backgroundColor: barColor + 'CC',
        borderColor: barColor,
        borderWidth: 1,
        borderRadius: 3,
        order: 2,
      });
    });

    if (blAvgArr) {
      datasets.push({
        label: 'Baseline Normalized',
        data: blAvgArr.map(function (v) {
          return v > 0 ? v : null;
        }),
        type: 'line',
        borderColor: BL_LINE_COLOR,
        borderWidth: 2,
        borderDash: [6, 3],
        pointRadius: 0,
        fill: false,
        order: 1,
      });
    }

    var isInteractive = options.interactive !== false;

    var chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: isInteractive ? 'rgba(200,210,230,0.85)' : '#000',
            font: { size: isInteractive ? 10 : 9 },
            boxWidth: 12,
            padding: 10,
          },
        },
        tooltip: isInteractive
          ? {
              mode: 'index',
              intersect: false,
              callbacks: {
                label: function (ctx) {
                  var v = ctx.parsed.y;
                  if (v == null) return null;
                  return ctx.dataset.label + ': ' + Math.round(v).toLocaleString() + ' ' + unit;
                },
              },
            }
          : { enabled: false },
      },
      scales: {
        x: {
          ticks: {
            color: isInteractive ? undefined : '#333',
            font: { size: isInteractive ? 10 : 9 },
            maxRotation: 45,
          },
          grid: { color: isInteractive ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.1)' },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: isInteractive ? undefined : '#333',
            font: { size: isInteractive ? 10 : 9 },
          },
          grid: { color: isInteractive ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.1)' },
          title: { display: true, text: unit, font: { size: isInteractive ? 10 : 9 } },
        },
      },
    };

    var chart = new Chart(canvas, {
      type: 'bar',
      data: { labels: DEFAULT_MONTHS, datasets: datasets },
      options: chartOptions,
    });
    _chartInstances[canvasId] = chart;
    return chart;
  }

  function renderEUIBenchmarkChart(canvasId, data, options) {
    options = options || {};
    var canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    if (_chartInstances[canvasId]) _chartInstances[canvasId].destroy();

    var buildings = data.buildings;
    var labels = buildings.map(function (b) {
      return b.name;
    });
    var isInteractive = options.interactive !== false;

    var bgColors = buildings.map(function (b) {
      return b.eui <= b.cbecs ? 'rgba(34, 197, 94, 0.8)' : 'rgba(239, 68, 68, 0.7)';
    });
    var borderColors = buildings.map(function (b) {
      return b.eui <= b.cbecs ? '#16a34a' : '#ef4444';
    });

    var datasets = [
      {
        label: 'Current EUI',
        data: buildings.map(function (b) {
          return b.eui;
        }),
        backgroundColor: bgColors,
        borderColor: borderColors,
        borderWidth: 1,
        borderRadius: 3,
        order: 2,
      },
      {
        label: 'CBECS Median',
        data: buildings.map(function (b) {
          return b.cbecs;
        }),
        type: 'line',
        borderColor: 'transparent',
        borderWidth: 0,
        pointRadius: 0,
        pointBackgroundColor: 'transparent',
        fill: false,
        order: 1,
        pointStyle: 'line',
        hidden: false,
        _isCbecsRef: true,
      },
    ];

    if (options.showBaseline) {
      datasets.unshift({
        label: 'Baseline EUI',
        data: buildings.map(function (b) {
          return b.blEui || 0;
        }),
        backgroundColor: 'rgba(168, 85, 247, 0.5)',
        borderColor: '#a855f7',
        borderWidth: 1,
        borderRadius: 3,
        order: 3,
      });
    }

    // Collect unique CBECS values for vertical reference lines
    var uniqueCbecs = [];
    buildings.forEach(function (b) {
      if (b.cbecs > 0 && uniqueCbecs.indexOf(b.cbecs) === -1) uniqueCbecs.push(b.cbecs);
    });

    var cbecsLinePlugin = {
      id: 'cbecsVerticalLine',
      afterDraw: function (chart) {
        var xScale = chart.scales.x;
        var yScale = chart.scales.y;
        if (!xScale || !yScale) return;
        var ctx = chart.ctx;
        uniqueCbecs.forEach(function (val) {
          var xPx = xScale.getPixelForValue(val);
          if (xPx < xScale.left || xPx > xScale.right) return;
          ctx.save();
          ctx.beginPath();
          ctx.setLineDash([6, 4]);
          ctx.moveTo(xPx, yScale.top);
          ctx.lineTo(xPx, yScale.bottom);
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#f59e0b';
          ctx.stroke();
          // Label
          ctx.font = '10px sans-serif';
          ctx.fillStyle = isInteractive ? 'rgba(245,158,11,0.9)' : '#b45309';
          ctx.textAlign = 'center';
          ctx.fillText('CBECS ' + Math.round(val), xPx, yScale.top - 6);
          ctx.restore();
        });
      },
    };

    var chart = new Chart(canvas, {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      plugins: [cbecsLinePlugin],
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: isInteractive ? 'rgba(220,230,240,0.92)' : '#000',
              font: { size: isInteractive ? 10 : 9 },
              usePointStyle: true,
              pointStyleWidth: 12,
            },
          },
          tooltip: { enabled: isInteractive },
        },
        scales: {
          x: {
            beginAtZero: true,
            title: {
              display: true,
              text: 'kBtu/ft²/yr',
              color: isInteractive ? 'rgba(220,230,240,0.88)' : '#333',
              font: { size: 10 },
            },
            ticks: {
              color: isInteractive ? 'rgba(220,230,240,0.88)' : '#333',
              font: { size: 9 },
            },
            grid: {
              display: true,
              color: isInteractive ? 'rgba(200,210,230,0.18)' : 'rgba(0,0,0,0.1)',
            },
          },
          y: {
            ticks: {
              color: isInteractive ? 'rgba(200,210,230,0.85)' : '#000',
              font: { size: 10, weight: '600' },
            },
            grid: { display: false },
          },
        },
      },
    });

    _chartInstances[canvasId] = chart;
    return chart;
  }

  function renderSavingsChart(canvasId, data, options) {
    options = options || {};
    var canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    if (_chartInstances[canvasId]) _chartInstances[canvasId].destroy();
    var isInteractive = options.interactive !== false;

    var chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: data.months,
        datasets: [
          {
            label: 'Baseline',
            data: data.baseline,
            backgroundColor: 'rgba(168, 85, 247, 0.6)',
            borderColor: '#a855f7',
            borderWidth: 1,
            borderRadius: 3,
            order: 2,
          },
          {
            label: 'Actual',
            data: data.actual,
            backgroundColor: 'rgba(34, 197, 94, 0.7)',
            borderColor: '#16a34a',
            borderWidth: 1,
            borderRadius: 3,
            order: 2,
          },
          {
            label: 'Savings',
            data: data.savings,
            type: 'line',
            borderColor: '#3b82f6',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#3b82f6',
            fill: false,
            yAxisID: 'y1',
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: {
              color: isInteractive ? 'rgba(200,210,230,0.85)' : '#000',
              font: { size: isInteractive ? 10 : 9 },
            },
          },
          tooltip: { enabled: isInteractive },
        },
        scales: {
          x: {
            ticks: {
              color: isInteractive ? 'rgba(220,230,240,0.88)' : '#333',
              font: { size: 9 },
              maxRotation: 45,
            },
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            position: 'left',
            ticks: {
              color: isInteractive ? 'rgba(220,230,240,0.88)' : '#333',
              font: { size: 9 },
            },
            grid: {
              color: isInteractive ? 'rgba(200,210,230,0.18)' : 'rgba(0,0,0,0.1)',
            },
          },
          y1: {
            beginAtZero: true,
            position: 'right',
            ticks: {
              color: isInteractive ? 'rgba(59,130,246,0.6)' : '#3b82f6',
              font: { size: 9 },
              callback: function (v) {
                return data.unit === '$' ? '$' + v.toLocaleString() : v.toLocaleString();
              },
            },
            grid: { display: false },
          },
        },
      },
    });

    _chartInstances[canvasId] = chart;
    return chart;
  }

  function destroyChart(canvasId) {
    if (_chartInstances[canvasId]) {
      _chartInstances[canvasId].destroy();
      delete _chartInstances[canvasId];
    }
  }

  function destroyAll() {
    Object.keys(_chartInstances).forEach(destroyChart);
  }

  return {
    renderYearOverYearChart: renderYearOverYearChart,
    renderEUIBenchmarkChart: renderEUIBenchmarkChart,
    renderSavingsChart: renderSavingsChart,
    destroyChart: destroyChart,
    destroyAll: destroyAll,
    YR_PALETTE: YR_PALETTE,
    BL_LINE_COLOR: BL_LINE_COLOR,
    DEFAULT_MONTHS: DEFAULT_MONTHS,
  };
})();
