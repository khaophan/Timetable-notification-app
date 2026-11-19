import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  computed,
  effect,
  inject,
  OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import * as d3 from 'd3';
import { AppStore } from './store';
import { ClassSession, DEFAULT_SUBJECT_MAPPINGS } from './models';
import { computeDailyStudyStats, computeSubjectStudyStats } from './schedule-utils';

@Component({
  selector: 'app-study-analytics',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MatIconModule],
  template: `
    <div class="space-y-6">
      <!-- KPI Strip -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div
          class="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-4"
        >
          <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            ชั่วโมงเรียนรวมต่อสัปดาห์
          </span>
          <div class="mt-2 flex items-baseline gap-1.5">
            <span class="text-2xl font-extrabold text-slate-900 dark:text-white font-mono-num">
              {{ totalHours() }}
            </span>
            <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">ชม.</span>
          </div>
        </div>

        <div
          class="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-4"
        >
          <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            จำนวนคาบที่เรียนจริง
          </span>
          <div class="mt-2 flex items-baseline gap-1.5">
            <span class="text-2xl font-extrabold text-sky-600 dark:text-sky-400 font-mono-num">
              {{ totalSessions() }}
            </span>
            <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">คาบ</span>
          </div>
        </div>

        <div
          class="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-4"
        >
          <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            วันที่เรียนหนักที่สุด
          </span>
          <div class="mt-2 text-lg font-extrabold text-slate-900 dark:text-white truncate">
            {{ busiestDay()?.thaiDay || 'ยังไม่มีข้อมูล' }}
          </div>
          @if (busiestDay(); as peak) {
            <span class="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
              {{ peak.hours }} ชม. ({{ peak.sessionCount }} คาบ)
            </span>
          }
        </div>

        <div
          class="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-4"
        >
          <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            เฉลี่ยต่อวัน
          </span>
          <div class="mt-2 flex items-baseline gap-1.5">
            <span class="text-2xl font-extrabold text-emerald-600 dark:text-emerald-400 font-mono-num">
              {{ avgHoursPerDay() }}
            </span>
            <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">ชม./วัน</span>
          </div>
        </div>
      </div>

      <!-- D3 Weekly Study Chart -->
      <div
        class="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-5"
      >
        <div class="flex items-center justify-between gap-2 mb-4">
          <div>
            <h3 class="text-sm font-bold text-slate-900 dark:text-white">
              กราฟชั่วโมงเรียนรายวัน (ไม่รวมพักเที่ยงและเลิกเรียน)
            </h3>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              คำนวณจากตารางเรียนหลักรวมกับหมวดตารางส่วนตัวที่เปิดแจ้งเตือนอยู่
            </p>
          </div>
          <mat-icon class="text-sky-600 dark:text-sky-400">bar_chart</mat-icon>
        </div>

        <div #chartHost class="w-full min-h-[240px]"></div>
      </div>

      <!-- Top Subjects Breakdown -->
      <div
        class="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-5"
      >
        <h3 class="text-sm font-bold text-slate-900 dark:text-white mb-4">
          สัดส่วนเวลาเรียนแยกตามรายวิชา
        </h3>
        @if (subjectStats().length === 0) {
          <p class="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
            ยังไม่มีข้อมูลรายวิชาสำหรับแสดงสถิติ
          </p>
        } @else {
          <div class="space-y-3">
            @for (item of subjectStats(); track item.subject) {
              <div class="space-y-1.5">
                <div class="flex items-center justify-between text-xs">
                  <span class="font-semibold text-slate-800 dark:text-slate-100 truncate pr-3">
                    {{ item.subject }}
                  </span>
                  <span class="font-mono-num text-slate-500 dark:text-slate-400 shrink-0">
                    {{ item.hours }} ชม. ({{ item.sessionCount }} คาบ)
                  </span>
                </div>
                <div class="h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    class="h-full rounded-full bg-sky-600 dark:bg-sky-400 transition-all duration-500"
                    [style.width.%]="maxSubjectMinutes() > 0 ? (item.minutes / maxSubjectMinutes()) * 100 : 0"
                  ></div>
                </div>
              </div>
            }
          </div>
        }
      </div>
    </div>
  `,
})
export class StudyAnalytics implements AfterViewInit, OnDestroy {
  private store = inject(AppStore);

  @ViewChild('chartHost', { static: false }) chartHost?: ElementRef<HTMLDivElement>;
  private resizeObserver?: ResizeObserver;
  private isReady = false;

  readonly dailyStats = computed(() => computeDailyStudyStats(this.store.effectiveSchedule()));
  readonly subjectStats = computed(() =>
    computeSubjectStudyStats(this.store.effectiveSchedule(), (s) => this.resolveSubjectName(s))
  );

  readonly totalMinutes = computed(() =>
    this.dailyStats().reduce((acc, d) => acc + d.minutes, 0)
  );
  readonly totalHours = computed(() => Math.round((this.totalMinutes() / 60) * 10) / 10);
  readonly totalSessions = computed(() =>
    this.dailyStats().reduce((acc, d) => acc + d.sessionCount, 0)
  );
  readonly busiestDay = computed(() => {
    const activeDays = this.dailyStats().filter((d) => d.minutes > 0);
    if (activeDays.length === 0) return null;
    return activeDays.reduce((a, b) => (b.minutes > a.minutes ? b : a));
  });
  readonly avgHoursPerDay = computed(() => {
    const activeDays = this.dailyStats().filter((d) => d.minutes > 0);
    if (activeDays.length === 0) return 0;
    return Math.round((this.totalMinutes() / 60 / activeDays.length) * 10) / 10;
  });
  readonly maxSubjectMinutes = computed(() => {
    const list = this.subjectStats();
    return list.length > 0 ? list[0].minutes : 0;
  });

  constructor() {
    effect(() => {
      this.dailyStats();
      this.store.themeMode();
      if (this.isReady) {
        setTimeout(() => this.renderChart(), 0);
      }
    });
  }

  ngAfterViewInit(): void {
    this.isReady = true;
    this.renderChart();
    if (typeof ResizeObserver !== 'undefined' && this.chartHost?.nativeElement) {
      this.resizeObserver = new ResizeObserver(() => this.renderChart());
      this.resizeObserver.observe(this.chartHost.nativeElement);
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  private resolveSubjectName(session: ClassSession): string {
    const code = (session.subjectCode || '').trim().toUpperCase();
    return DEFAULT_SUBJECT_MAPPINGS[code] || session.subjectName || code || 'ไม่ระบุวิชา';
  }

  private renderChart(): void {
    const host = this.chartHost?.nativeElement;
    if (!host) return;

    const data = this.dailyStats();
    const isDark = this.store.themeMode() === 'dark';

    d3.select(host).selectAll('*').remove();

    const width = Math.max(host.clientWidth || 320, 280);
    const height = 240;
    const margin = { top: 20, right: 16, bottom: 32, left: 36 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const svg = d3
      .select(host)
      .append('svg')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('class', 'w-full h-[240px] select-none');

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3
      .scaleBand()
      .domain(data.map((d) => d.shortLabel))
      .range([0, innerWidth])
      .padding(0.36);

    const maxHours = Math.max(8, d3.max(data, (d) => d.hours) || 8);
    const y = d3.scaleLinear().domain([0, maxHours]).nice().range([innerHeight, 0]);

    const gridColor = isDark ? 'rgba(148,163,184,0.14)' : 'rgba(15,23,42,0.08)';
    const axisText = isDark ? '#94A3B8' : '#64748B';
    const barColor = isDark ? '#38BDF8' : '#0284C7';
    const valueText = isDark ? '#F8FAFC' : '#0F172A';

    g.append('g')
      .selectAll('line')
      .data(y.ticks(4))
      .join('line')
      .attr('x1', 0)
      .attr('x2', innerWidth)
      .attr('y1', (d) => y(d))
      .attr('y2', (d) => y(d))
      .attr('stroke', gridColor)
      .attr('stroke-dasharray', '3,3');

    g.append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(d3.axisBottom(x).tickSize(0))
      .call((axis) => axis.select('.domain').attr('stroke', gridColor))
      .selectAll('text')
      .attr('dy', '1.1em')
      .attr('fill', axisText)
      .style('font-size', '12px')
      .style('font-weight', '600');

    g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickSize(0))
      .call((axis) => axis.select('.domain').remove())
      .selectAll('text')
      .attr('dx', '-0.5em')
      .attr('fill', axisText)
      .style('font-size', '11px');

    g.selectAll('.bar')
      .data(data)
      .join('rect')
      .attr('x', (d) => x(d.shortLabel) ?? 0)
      .attr('y', (d) => y(d.hours))
      .attr('width', x.bandwidth())
      .attr('height', (d) => Math.max(2, innerHeight - y(d.hours)))
      .attr('rx', 8)
      .attr('fill', barColor);

    g.selectAll('.bar-value')
      .data(data.filter((d) => d.hours > 0))
      .join('text')
      .attr('x', (d) => (x(d.shortLabel) ?? 0) + x.bandwidth() / 2)
      .attr('y', (d) => y(d.hours) - 6)
      .attr('text-anchor', 'middle')
      .attr('fill', valueText)
      .style('font-size', '11px')
      .style('font-weight', '700')
      .text((d) => `${d.hours}h`);
  }
}
