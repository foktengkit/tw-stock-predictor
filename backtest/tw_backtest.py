"""
tw_backtest.py — 台股虛擬交易回測（只做多 / 空手）

快速使用
--------
    import pandas as pd
    from tw_backtest import backtest

    df = pd.read_csv("my_signals.csv")      # 需有 Date、Close、Signal 三個欄位
    result = backtest(df)
    print(result.report())

    result.daily    # 每日明細：收盤價、訊號、持倉、資產、每日報酬、回撤
    result.trades   # 每筆交易明細（已扣成本）
    result.metrics  # 所有指標（dict）

訊號定義
--------
    Signal > 0   → 想持有（做多）
    Signal <= 0  → 想空手
    台股融券放空另有借券費、強制回補等規則，本函數不支援做空；負值一律視為空手。

成交時點（防止前視偏差最重要的設定）
------------------------------------
    execution="next_close"（預設）
        第 t 天的訊號，在第 t+1 天收盤價成交。
        因為 Signal 通常是用「第 t 天收盤價」算出來的，收盤後才知道，
        不可能再用同一個收盤價買賣。這是只有收盤價時最嚴謹的假設。

    execution="same_close"
        第 t 天的訊號，就用第 t 天收盤價成交。
        只有在訊號「只用到第 t-1 天以前的資料」（或在 13:25 收盤競價前就能算出）時才合法，
        否則等於偷看了當天收盤價，回測會嚴重虛胖。

每日資產的計算順序（第 t 天）
----------------------------
    1. 以前一天收盤後的持股，按第 t 天收盤價計算市值（承受當天漲跌）
    2. 依「第 t 天要成交的目標持倉」在收盤價買進 / 賣出，並扣除成本
    3. 記錄成交後的資產 = 現金 + 持股 × 收盤價
"""

from __future__ import annotations

import math
import unicodedata
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

__all__ = ["TaiwanCosts", "BacktestResult", "backtest"]


# ════════════════════════════════════════════════════════════════════
# 交易成本
# ════════════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class TaiwanCosts:
    """台股交易成本。預設值即題目規範：買 0.1425%；賣 0.1425% + 證交稅 0.3%。

    其他常見情況：
      * 股票型 ETF 證交稅為 0.1%：TaiwanCosts(sell_tax_rate=0.001)
      * 券商手續費 2.8 折：TaiwanCosts(fee_discount=0.28)
      * 每筆最低手續費 20 元：資金大時不會觸發；設 min_fee=0 可完全照比例計算
    """

    buy_fee_rate: float = 0.001425   # 買進手續費率
    sell_fee_rate: float = 0.001425  # 賣出手續費率
    sell_tax_rate: float = 0.003     # 證券交易稅率（只在賣出時收）
    min_fee: float = 20.0            # 每筆最低手續費（新台幣）
    fee_discount: float = 1.0        # 手續費折扣（1.0 = 不打折）

    def buy_fee(self, amount: float) -> float:
        """買進 amount 元股票要付的手續費。"""
        if amount <= 0:
            return 0.0
        return max(self.min_fee, amount * self.buy_fee_rate * self.fee_discount)

    def sell_costs(self, amount: float) -> tuple[float, float]:
        """賣出 amount 元股票的（手續費, 證交稅）。"""
        if amount <= 0:
            return 0.0, 0.0
        fee = max(self.min_fee, amount * self.sell_fee_rate * self.fee_discount)
        return fee, amount * self.sell_tax_rate


def _max_buy_amount(cash: float, price: float, costs: TaiwanCosts, whole_shares: bool) -> float:
    """用手上全部現金買進時，能買到的「股票金額」（不含手續費）。

    要滿足：股票金額 + 手續費(股票金額) ≤ 現金。
    """
    if cash <= 0 or price <= 0:
        return 0.0
    rate = costs.buy_fee_rate * costs.fee_discount
    amount = cash / (1.0 + rate)          # 手續費照比例收時的上限
    if amount * rate < costs.min_fee:      # 金額太小，會被收最低手續費
        amount = cash - costs.min_fee
    if amount <= 0:
        return 0.0
    if not whole_shares:
        return amount
    # 整股（1 股為單位，台股可買零股）：往下取整，並確認含手續費後付得起
    n = math.floor(amount / price)
    while n > 0 and n * price + costs.buy_fee(n * price) > cash + 1e-9:
        n -= 1
    return n * price


# ════════════════════════════════════════════════════════════════════
# 回測結果
# ════════════════════════════════════════════════════════════════════
@dataclass
class BacktestResult:
    daily: pd.DataFrame          # 每日明細
    trades: pd.DataFrame         # 已平倉交易明細
    metrics: dict                # 策略指標
    benchmark: dict              # 買進持有指標（同樣成本假設）
    settings: dict               # 回測設定
    notes: list = field(default_factory=list)  # 資料處理與注意事項

    def report(self) -> str:
        return _format_report(self)

    def __str__(self) -> str:
        return self.report()


# ════════════════════════════════════════════════════════════════════
# 主函數
# ════════════════════════════════════════════════════════════════════
def backtest(
    df: pd.DataFrame,
    *,
    date_col: str = "Date",
    close_col: str = "Close",
    signal_col: str = "Signal",
    execution: str = "next_close",
    signal_threshold: float = 0.0,
    costs: TaiwanCosts = TaiwanCosts(),
    initial_capital: float = 1_000_000,
    risk_free_rate: float = 0.015,
    trading_days: int = 252,
    whole_shares: bool = True,
    close_at_end: bool = True,
) -> BacktestResult:
    """執行回測。

    參數
    ----
    df              : 含日期、收盤價、訊號的 DataFrame
    execution       : "next_close"（預設，隔日收盤成交）或 "same_close"（當日收盤成交，見模組說明）
    signal_threshold: Signal 大於此值才持有。預設 0（適用 1/0、1/-1 訊號）；
                      若 Signal 是模型輸出的上漲機率（0~1），通常要設 0.5
    costs           : 交易成本設定，見 TaiwanCosts
    initial_capital : 初始資金（新台幣）
    risk_free_rate  : 年化無風險利率，計算夏普比率用（預設 1.5%）
    trading_days    : 一年交易日數，年化用（慣例 252；台股實際約 245–250，影響很小）
    whole_shares    : True = 以 1 股為單位成交（零股），False = 允許小數股
    close_at_end    : True = 最後一天若仍持有，以收盤價強制平倉並扣賣出成本，
                      讓總報酬是「真的拿得到的錢」；False = 以市值計，不扣賣出成本
    """
    if execution not in ("next_close", "same_close"):
        raise ValueError('execution 只能是 "next_close" 或 "same_close"')

    data, notes = _prepare(df, date_col, close_col, signal_col)
    dates = pd.DatetimeIndex(data["Date"])
    close = data["Close"].to_numpy(dtype=float)
    sig = data["Signal"].to_numpy(dtype=float)
    want = (sig > signal_threshold).astype(int)  # 每天收盤後「想要」的持倉
    n = len(close)

    # 訊號看起來是 0~1 的機率，門檻卻還是 0 → 幾乎每天都會被當成「持有」，結果會完全失真
    fractional = (sig != np.round(sig)) & (sig > 0) & (sig < 1)
    if signal_threshold == 0 and fractional.mean() > 0.5:
        notes.append(
            "Signal 多數是 0~1 之間的小數（像是上漲機率），但目前只要 > 0 就視為持有。"
            "若要以 50% 為門檻，請加上 signal_threshold=0.5。"
        )

    # ── 目標持倉：第 t 天收盤時要成交成的部位 ──
    if execution == "next_close":
        target = np.r_[0, want[:-1]]       # 昨天的訊號，今天成交
        if want[-1] != target[-1]:
            notes.append("最後一天的訊號沒有隔日可以成交，未列入回測。")
    else:
        target = want.copy()
        notes.append("使用 same_close（當日收盤成交）：請確認 Signal 沒有用到當天收盤價，否則結果會虛胖。")

    held_at_end = bool(target[-1])
    if close_at_end:
        target[-1] = 0

    sim = _simulate(dates, close, target, costs, initial_capital, whole_shares)
    if sim["skipped_buy_days"]:
        notes.append(f"有 {sim['skipped_buy_days']} 天想買進但現金不足以買 1 股（已略過）。")
    if close_at_end and held_at_end and sim["trades"]:
        notes.append("期末仍持有部位，已在最後一天收盤價強制平倉並扣賣出成本（計入交易統計）。")
    if not close_at_end and sim["open_trade"] is not None:
        notes.append("期末仍持有部位：總報酬以市值計、未扣賣出成本；該筆未平倉交易不計入勝率。")

    # ── 買進持有基準：第一天收盤買進、最後一天收盤賣出，成本假設相同 ──
    bh_target = np.ones(n, dtype=int)
    bh_target[-1] = 0
    bh = _simulate(dates, close, bh_target, costs, initial_capital, whole_shares)

    trades = pd.DataFrame(sim["trades"])
    metrics = _performance(dates, sim["equity"], initial_capital, risk_free_rate, trading_days)
    metrics.update(_trade_stats(trades))
    metrics.update(
        exposure=float(sim["held"][:-1].mean()) if n > 1 else 0.0,  # 有持股過夜的天數比例
        total_fee=sim["total_fee"],
        total_tax=sim["total_tax"],
        final_equity=float(sim["equity"][-1]),
        open_trade=sim["open_trade"],
    )
    benchmark = _performance(dates, bh["equity"], initial_capital, risk_free_rate, trading_days)

    # ── 每日明細 ──
    eq = sim["equity"]
    prev = np.r_[initial_capital, eq[:-1]]
    peak = np.maximum.accumulate(np.r_[initial_capital, eq])[1:]
    daily = pd.DataFrame(
        {
            "Close": close,
            "Signal": data["Signal"].to_numpy(),
            "Position": sim["held"],          # 當天收盤成交後的持倉（1 = 持有）
            "Equity": eq,                     # 當天收盤後的總資產（已扣成本）
            "DailyReturn": eq / prev - 1.0,   # 每日報酬（已扣成本）
            "Drawdown": eq / peak - 1.0,      # 距離歷史高點的跌幅
        },
        index=dates,
    )
    daily.index.name = "Date"

    settings = dict(
        execution=execution, signal_threshold=signal_threshold, costs=costs, initial_capital=initial_capital, risk_free_rate=risk_free_rate,
        trading_days=trading_days, whole_shares=whole_shares, close_at_end=close_at_end,
    )
    return BacktestResult(daily=daily, trades=trades, metrics=metrics, benchmark=benchmark, settings=settings, notes=notes)


# ════════════════════════════════════════════════════════════════════
# 資料檢查
# ════════════════════════════════════════════════════════════════════
def _prepare(df: pd.DataFrame, date_col: str, close_col: str, signal_col: str):
    # 日期放在 index 的常見寫法（例如 yfinance 下載的資料）：自動移回欄位
    if date_col not in df.columns and (df.index.name == date_col or isinstance(df.index, pd.DatetimeIndex)):
        df = df.reset_index().rename(columns={df.index.name or "index": date_col})
    missing = [c for c in (date_col, close_col, signal_col) if c not in df.columns]
    if missing:
        raise KeyError(f"DataFrame 缺少欄位：{missing}（目前欄位：{list(df.columns)}）")

    data = pd.DataFrame(
        {
            "Date": pd.to_datetime(df[date_col]).to_numpy(),
            "Close": pd.to_numeric(df[close_col], errors="coerce").to_numpy(dtype=float),
            "Signal": pd.to_numeric(df[signal_col], errors="coerce").to_numpy(dtype=float),
        }
    )
    notes: list[str] = []

    if not data["Date"].is_monotonic_increasing:
        data = data.sort_values("Date", kind="stable")
        notes.append("輸入資料未依日期排序，已自動由舊到新排序。")
    data = data.reset_index(drop=True)

    dup = data["Date"][data["Date"].duplicated(keep=False)]
    if len(dup):
        raise ValueError(f"日期重複，請先處理：{sorted({d.date().isoformat() for d in dup})[:5]}")

    bad = data["Close"].isna() | (data["Close"] <= 0)
    if bad.any():
        sample = [d.date().isoformat() for d in data.loc[bad, "Date"].head(5)]
        raise ValueError(
            f"Close 有 {int(bad.sum())} 筆缺值或非正數（例如 {sample}）。"
            "停牌日請直接刪除該列，不要用前後價格補值。"
        )

    na = int(data["Signal"].isna().sum())
    if na:
        # 只能視為空手或用「過去」的值往後補；用 bfill 往前補等於偷看未來
        data["Signal"] = data["Signal"].fillna(0.0)
        notes.append(f"Signal 有 {na} 筆缺值，已視為 0（空手）。")
    if (data["Signal"] < 0).any():
        notes.append("Signal 有負值：本回測只做多，負值視為空手。")

    if len(data) < 2:
        raise ValueError("至少需要 2 個交易日的資料")
    return data, notes


# ════════════════════════════════════════════════════════════════════
# 逐日模擬（現金 + 持股，所有成本都以實際金額扣除）
# ════════════════════════════════════════════════════════════════════
def _simulate(dates, close, target, costs: TaiwanCosts, initial_capital: float, whole_shares: bool) -> dict:
    n = len(close)
    cash, shares = float(initial_capital), 0.0
    equity = np.empty(n)
    held = np.zeros(n, dtype=int)
    trades: list[dict] = []
    open_trade: dict | None = None
    total_fee = total_tax = 0.0
    skipped = 0

    for t in range(n):
        price = close[t]

        if target[t] == 1 and shares == 0:                     # ── 買進 ──
            amount = _max_buy_amount(cash, price, costs, whole_shares)
            if amount > 0:
                fee = costs.buy_fee(amount)
                shares = amount / price
                cash = max(0.0, cash - amount - fee)           # 避免浮點誤差出現 -0.0000001
                total_fee += fee
                open_trade = dict(
                    entry_date=dates[t], entry_price=price, shares=shares,
                    cost_basis=amount + fee, entry_index=t,     # cost_basis 含買進手續費
                )
            else:
                skipped += 1

        elif target[t] == 0 and shares > 0:                     # ── 賣出 ──
            amount = shares * price
            fee, tax = costs.sell_costs(amount)
            proceeds = amount - fee - tax                       # 實際拿回的錢
            cash += proceeds
            total_fee += fee
            total_tax += tax
            trades.append(
                dict(
                    entry_date=open_trade["entry_date"],
                    exit_date=dates[t],
                    entry_price=open_trade["entry_price"],
                    exit_price=price,
                    shares=open_trade["shares"],
                    holding_days=t - open_trade["entry_index"],  # 交易日數
                    gross_return=price / open_trade["entry_price"] - 1.0,        # 未扣成本
                    net_return=proceeds / open_trade["cost_basis"] - 1.0,         # 已扣買賣成本
                    pnl=proceeds - open_trade["cost_basis"],                      # 損益（元）
                )
            )
            shares, open_trade = 0.0, None

        held[t] = 1 if shares > 0 else 0
        equity[t] = cash + shares * price

    if open_trade is not None:   # close_at_end=False 時才會發生
        open_trade = dict(open_trade, mark_price=close[-1], unrealized_pnl=shares * close[-1] - open_trade["cost_basis"])

    return dict(equity=equity, held=held, trades=trades, open_trade=open_trade,
                total_fee=total_fee, total_tax=total_tax, skipped_buy_days=skipped)


# ════════════════════════════════════════════════════════════════════
# 指標
# ════════════════════════════════════════════════════════════════════
def _performance(dates: pd.DatetimeIndex, equity: np.ndarray, initial: float, rf: float, td: int) -> dict:
    """總報酬、年化報酬、波動度、夏普比率、最大回撤（含發生時間）。"""
    values = np.r_[initial, equity]                  # 第 0 個元素是「開始前」的初始資金
    rets = values[1:] / values[:-1] - 1.0            # 每日報酬（已扣成本）

    total_return = equity[-1] / initial - 1.0
    years = (dates[-1] - dates[0]).days / 365.25
    cagr = (1 + total_return) ** (1 / years) - 1 if years > 0 and total_return > -1 else float("nan")
    vol = float(np.std(rets, ddof=1) * math.sqrt(td)) if len(rets) > 1 else float("nan")

    # 夏普比率：每日超額報酬（扣掉每日無風險利率）的平均 ÷ 標準差 × √年交易日
    # 空手的日子報酬為 0、超額報酬為負（現金不計利息），這是保守的算法
    rf_daily = (1 + rf) ** (1 / td) - 1
    excess = rets - rf_daily
    sd = np.std(excess, ddof=1) if len(excess) > 1 else 0.0
    sharpe = float(np.mean(excess) / sd * math.sqrt(td)) if sd > 0 else float("nan")

    # 最大回撤：資產從歷史高點往下跌的最大幅度
    peaks = np.maximum.accumulate(values)
    dd = values / peaks - 1.0
    i_trough = int(np.argmin(dd))
    mdd = float(dd[i_trough])
    label = lambda k: "期初" if k == 0 else dates[k - 1]   # values 的位置 → 日期
    if mdd < 0:
        i_peak = int(np.flatnonzero(values[: i_trough + 1] == peaks[i_trough])[-1])  # 跌破前最後一次創高
        after = np.flatnonzero(values[i_trough + 1 :] >= peaks[i_trough])
        i_rec = i_trough + 1 + int(after[0]) if len(after) else None
        mdd_info = dict(
            peak_date=label(i_peak), peak_value=float(values[i_peak]),
            trough_date=label(i_trough), trough_value=float(values[i_trough]),
            recovery_date=label(i_rec) if i_rec is not None else None,
            decline_days=i_trough - i_peak,                                   # 前高 → 谷底（交易日）
            recovery_days=(i_rec - i_trough) if i_rec is not None else None,  # 谷底 → 回到前高（交易日）
        )
    else:
        mdd_info = None

    return dict(total_return=float(total_return), cagr=float(cagr), volatility=vol, sharpe=sharpe,
                max_drawdown=mdd, mdd=mdd_info, start=dates[0], end=dates[-1], days=len(dates), years=years)


def _wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """勝率的 Wilson 95% 信賴區間（交易筆數少時比常態近似準）。"""
    p, d = k / n, 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def _trade_stats(trades: pd.DataFrame) -> dict:
    """勝率、盈虧比等交易統計（只計已平倉交易，報酬皆已扣成本）。"""
    nan = float("nan")
    if trades.empty:
        return dict(trades=0, wins=0, losses=0, win_rate=nan, win_rate_ci=None, avg_win=nan, avg_loss=nan,
                    pl_ratio=nan, profit_factor=nan, expectancy=nan, avg_holding_days=nan)
    r = trades["net_return"]
    wins, losses = trades[r > 0], trades[r <= 0]
    avg_win = float(wins["net_return"].mean()) if len(wins) else nan
    avg_loss = float(losses["net_return"].mean()) if len(losses) else nan
    if len(wins) and len(losses) and avg_loss < 0:
        pl_ratio = avg_win / abs(avg_loss)                        # 盈虧比 = 平均獲利 ÷ 平均虧損
    elif len(wins) and not len(losses):
        pl_ratio = float("inf")
    else:
        pl_ratio = nan
    gross_loss = abs(losses["pnl"].sum())
    profit_factor = wins["pnl"].sum() / gross_loss if gross_loss > 0 else (float("inf") if len(wins) else nan)
    return dict(
        trades=len(trades), wins=len(wins), losses=len(losses),
        win_rate=len(wins) / len(trades), win_rate_ci=_wilson(len(wins), len(trades)),
        avg_win=avg_win, avg_loss=avg_loss, pl_ratio=float(pl_ratio), profit_factor=float(profit_factor),
        expectancy=float(r.mean()),                               # 每筆平均淨報酬
        avg_holding_days=float(trades["holding_days"].mean()),
    )


# ════════════════════════════════════════════════════════════════════
# 文字報告
# ════════════════════════════════════════════════════════════════════
def _w(s: str) -> int:
    """終端機顯示寬度（中文字佔 2 格），用來對齊欄位。"""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in s)


def _pad(s: str, width: int, right: bool = False) -> str:
    gap = " " * max(0, width - _w(s))
    return gap + s if right else s + gap


def _pct(x, signed: bool = True) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "—"
    return f"{x * 100:+.2f}%" if signed else f"{x * 100:.2f}%"


def _num(x, digits: int = 2) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "—"
    if math.isinf(x):
        return "∞（無虧損交易）"
    return f"{x:.{digits}f}"


def _money(x: float) -> str:
    return f"{x:,.0f} 元"


def _date(d) -> str:
    return d if isinstance(d, str) else pd.Timestamp(d).strftime("%Y-%m-%d")


def _format_report(res: BacktestResult) -> str:
    m, b, s = res.metrics, res.benchmark, res.settings
    c: TaiwanCosts = s["costs"]
    L = []
    line = "═" * 58
    L += [line, "台股回測報告".center(52), line]
    L.append(f"期間：{_date(m['start'])} ～ {_date(m['end'])}（{m['days']} 個交易日，約 {m['years']:.2f} 年）")
    L.append(f"資金：{_money(s['initial_capital'])} → {_money(m['final_equity'])}")

    L += ["", "【交易假設】"]
    L.append("  成交時點：" + ("訊號隔日收盤價成交（next_close，避免前視偏差）" if s["execution"] == "next_close"
                         else "訊號當日收盤價成交（same_close，訊號不可用到當日收盤價）"))
    L.append(f"  訊號規則：Signal > {s['signal_threshold']:g} 視為持有，其餘空手（只做多）")
    disc = "" if c.fee_discount == 1 else f"，手續費 {c.fee_discount:g} 折"
    L.append(f"  交易成本：買進手續費 {c.buy_fee_rate*100:.4f}%；賣出手續費 {c.sell_fee_rate*100:.4f}% + 證交稅 {c.sell_tax_rate*100:.2f}%"
             f"（每筆最低手續費 {c.min_fee:g} 元{disc}）")
    L.append(f"  部位：每次全額進出、{'以 1 股為單位（零股）' if s['whole_shares'] else '允許小數股'}；空手資金不計利息；未計滑價")
    L.append(f"  夏普比率：無風險利率 {s['risk_free_rate']*100:.2f}%／年，年化以 {s['trading_days']} 個交易日計")

    L += ["", "【績效】"]
    W1, W2 = 20, 14
    L.append("  " + _pad("", W1) + _pad("策略", W2, True) + _pad("買進持有", W2, True))
    rows = [
        ("總報酬率", _pct(m["total_return"]), _pct(b["total_return"])),
        ("年化報酬率 (CAGR)", _pct(m["cagr"]), _pct(b["cagr"])),
        ("年化波動度", _pct(m["volatility"], False), _pct(b["volatility"], False)),
        ("夏普比率", _num(m["sharpe"]), _num(b["sharpe"])),
        ("最大回撤 (MDD)", _pct(m["max_drawdown"]), _pct(b["max_drawdown"])),
    ]
    for name, v1, v2 in rows:
        L.append("  " + _pad(name, W1) + _pad(v1, W2, True) + _pad(v2, W2, True))

    L += ["", "【最大回撤】"]
    d = m["mdd"]
    if d is None:
        L.append("  資產從未低於先前高點（沒有回撤）")
    else:
        L.append(f"  幅度：{_pct(m['max_drawdown'])}")
        L.append(f"  前高：{_date(d['peak_date'])}（資產 {_money(d['peak_value'])}）")
        L.append(f"  谷底：{_date(d['trough_date'])}（資產 {_money(d['trough_value'])}），下跌歷時 {d['decline_days']} 個交易日")
        if d["recovery_date"] is not None:
            L.append(f"  回復：{_date(d['recovery_date'])} 回到前高（谷底後 {d['recovery_days']} 個交易日）")
        else:
            L.append("  回復：至期末尚未回到前高")

    L += ["", "【交易統計】（只計已平倉交易，報酬皆已扣買賣成本）"]
    if m["trades"] == 0:
        L.append("  期間內沒有任何已平倉交易")
    else:
        lo, hi = m["win_rate_ci"]
        L.append(f"  交易次數：{m['trades']} 筆（{m['wins']} 勝 {m['losses']} 敗），平均持有 {m['avg_holding_days']:.1f} 個交易日")
        L.append(f"  勝率：{_pct(m['win_rate'], False)}（95% 信賴區間 {lo*100:.1f}%–{hi*100:.1f}%）")
        L.append(f"  平均獲利 / 平均虧損：{_pct(m['avg_win'])} / {_pct(m['avg_loss'])}")
        L.append(f"  盈虧比（平均獲利 ÷ 平均虧損）：{_num(m['pl_ratio'])}")
        L.append(f"  獲利因子（總獲利 ÷ 總虧損）：{_num(m['profit_factor'])}")
        L.append(f"  每筆期望報酬：{_pct(m['expectancy'])}")
    if m["open_trade"] is not None:
        o = m["open_trade"]
        L.append(f"  未平倉：{_date(o['entry_date'])} 以 {o['entry_price']:.2f} 買進，未實現損益 {_money(o['unrealized_pnl'])}（未扣賣出成本）")
    L.append(f"  持倉時間比例：{_pct(m['exposure'], False)}")
    cost_total = m["total_fee"] + m["total_tax"]
    L.append(f"  交易成本合計：{_money(cost_total)}（手續費 {_money(m['total_fee'])}、證交稅 {_money(m['total_tax'])}；"
             f"占初始資金 {cost_total / s['initial_capital'] * 100:.2f}%）")

    warn = list(res.notes)
    if 0 < m["trades"] < 30:
        warn.append(f"已平倉交易只有 {m['trades']} 筆，勝率與盈虧比的統計誤差很大（見信賴區間），不宜據此下結論。")
    if m["total_return"] < b["total_return"]:
        warn.append("策略總報酬低於「買進持有」：扣成本後，這個訊號沒有比單純持有更好。")
    if warn:
        L += ["", "【注意事項】"]
        L += [f"  • {w}" for w in warn]
    L.append(line)
    return "\n".join(L)


# ════════════════════════════════════════════════════════════════════
# 範例：直接執行 python tw_backtest.py
# ════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import sys
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")  # 輸出導向檔案時，Windows 繁中編碼（cp950）印不出 ✔ 等符號，不要因此中斷

    rng = np.random.default_rng(42)
    dates = pd.bdate_range("2023-01-02", periods=750)
    close = 100 * np.exp(np.cumsum(rng.normal(0.0004, 0.018, len(dates))))
    demo = pd.DataFrame({"Date": dates, "Close": close.round(2)})
    # 範例訊號：20 日均線在 60 日均線之上就持有。rolling 只用到當天以前的資料，搭配 next_close 不會偷看未來
    ma20 = demo["Close"].rolling(20).mean()
    ma60 = demo["Close"].rolling(60).mean()
    demo["Signal"] = (ma20 > ma60).astype(int)
    print(backtest(demo).report())
