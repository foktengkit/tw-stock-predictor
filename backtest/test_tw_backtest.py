"""
tw_backtest 的驗證測試：每一條規則都用「手算得出的答案」比對。
執行：python test_tw_backtest.py（或 pytest）
"""
import math

import numpy as np
import pandas as pd

from tw_backtest import TaiwanCosts, backtest

NO_MIN = TaiwanCosts(min_fee=0)          # 只照比例收費，方便手算
FREE = TaiwanCosts(0, 0, 0, 0)            # 零成本，用來驗證報酬與回撤本身
BUY = 1 / (1 + 0.001425)                  # 全額買進後「股票市值 / 投入現金」
SELL = 1 - 0.001425 - 0.003               # 賣出後「拿回現金 / 股票市值」


def frame(close, signal, start="2024-01-01"):
    return pd.DataFrame({"Date": pd.bdate_range(start, periods=len(close)), "Close": close, "Signal": signal})


def close_to(a, b, tol=1e-9):
    assert math.isclose(a, b, rel_tol=0, abs_tol=tol), f"{a} != {b}"


def test_一次完整交易的成本():
    # 100 買、110 賣：淨報酬 = 1.1 × 買進係數 × 賣出係數 − 1
    r = backtest(frame([100, 110], [1, 0]), execution="same_close", costs=NO_MIN, whole_shares=False)
    expected = 1.1 * BUY * SELL - 1
    close_to(r.metrics["total_return"], expected)
    close_to(r.trades["net_return"].iloc[0], expected)
    close_to(r.metrics["total_fee"] + r.metrics["total_tax"],
             1_000_000 - 1_000_000 * BUY + 1_000_000 * BUY * 1.1 * (1 - SELL), 1e-6)


def test_賣出成本合計_0_4425():
    r = backtest(frame([100, 100], [1, 0]), execution="same_close", costs=NO_MIN, whole_shares=False)
    shares_value = 1_000_000 * BUY
    close_to(r.metrics["total_tax"], shares_value * 0.003, 1e-6)
    close_to(r.metrics["total_fee"], 1_000_000 - shares_value + shares_value * 0.001425, 1e-6)


def test_next_close_延遲一天成交():
    # 第 0 天訊號 → 第 1 天收盤(100)買；第 1 天訊號 0 → 第 2 天收盤(120)賣
    df = frame([100, 100, 120, 120], [1, 0, 0, 0])
    nxt = backtest(df, costs=NO_MIN, whole_shares=False)
    close_to(nxt.metrics["total_return"], 1.2 * BUY * SELL - 1)
    assert nxt.trades["entry_date"].iloc[0] == df["Date"].iloc[1]
    # same_close：第 0 天 100 買、第 1 天 100 賣 → 只剩成本
    same = backtest(df, execution="same_close", costs=NO_MIN, whole_shares=False)
    close_to(same.metrics["total_return"], BUY * SELL - 1)


def test_偷看明天的訊號在_next_close_下失效():
    # Signal = 「明天會漲」：same_close 會賺到不可能的報酬；next_close 把它還原成一般訊號
    rng = np.random.default_rng(0)
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, 1500)))
    s = pd.Series(close)
    cheat = (s.shift(-1) > s).astype(int)
    df = frame(close, cheat)
    same = backtest(df, execution="same_close")
    nxt = backtest(df)
    assert same.metrics["total_return"] > 100, same.metrics["total_return"]      # 虛胖到 100 倍以上
    assert nxt.metrics["total_return"] < 0.5, nxt.metrics["total_return"]        # 回到正常範圍


def test_最大回撤與發生時間():
    df = frame([100, 120, 90, 60, 130], [1, 1, 1, 1, 1])
    r = backtest(df, execution="same_close", costs=FREE, whole_shares=False)
    close_to(r.metrics["max_drawdown"], 60 / 120 - 1)                            # -50%
    d = r.metrics["mdd"]
    assert d["peak_date"] == df["Date"].iloc[1]
    assert d["trough_date"] == df["Date"].iloc[3]
    assert d["recovery_date"] == df["Date"].iloc[4]
    assert d["decline_days"] == 2 and d["recovery_days"] == 1


def test_回撤從初始資金算起():
    # 第一天就買進並虧損：前高應是「期初」，而不是第一天收盤
    df = frame([100, 80, 90], [1, 1, 1])
    r = backtest(df, execution="same_close", costs=NO_MIN, whole_shares=False)
    assert r.metrics["mdd"]["peak_date"] == "期初"


def test_勝率與盈虧比():
    # 三筆交易（零成本）：+10%、−5%、+20%
    close = [100, 110, 110, 100, 95, 95, 100, 120, 120]
    sig = [1, 0, 0, 1, 0, 0, 1, 0, 0]
    r = backtest(frame(close, sig), execution="same_close", costs=FREE, whole_shares=False)
    m = r.metrics
    assert m["trades"] == 3 and m["wins"] == 2
    close_to(m["win_rate"], 2 / 3)
    close_to(m["avg_win"], 0.15)
    close_to(m["avg_loss"], -0.05)
    close_to(m["pl_ratio"], 3.0)


def test_夏普比率公式():
    rng = np.random.default_rng(1)
    close = 100 * np.exp(np.cumsum(rng.normal(0.0005, 0.01, 300)))
    r = backtest(frame(close, [1] * 300), execution="same_close", costs=FREE, whole_shares=False)
    rets = r.daily["DailyReturn"].to_numpy()
    rf = (1.015) ** (1 / 252) - 1
    expected = (rets - rf).mean() / (rets - rf).std(ddof=1) * math.sqrt(252)
    close_to(r.metrics["sharpe"], expected)


def test_各筆交易連乘等於總報酬():
    rng = np.random.default_rng(2)
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.015, 400)))
    sig = (rng.random(400) > 0.6).astype(int)
    r = backtest(frame(close, sig), costs=NO_MIN, whole_shares=False)
    close_to(np.prod(1 + r.trades["net_return"]) - 1, r.metrics["total_return"], 1e-9)


def test_最低手續費():
    # 資金 1 萬元：買進手續費 10000 × 0.1425% ≈ 14 元 < 20 元，應收 20 元
    r = backtest(frame([100, 100], [1, 0]), execution="same_close", initial_capital=10_000, whole_shares=False)
    t = r.trades.iloc[0]
    close_to(t["shares"] * 100, 10_000 - 20)


def test_整股不足一股時略過():
    r = backtest(frame([5000, 5000], [1, 0]), execution="same_close", initial_capital=3000)
    assert r.metrics["trades"] == 0
    assert any("現金不足" in n for n in r.notes)


def test_沒有交易也能產生報告():
    r = backtest(frame([100, 101, 102], [0, 0, 0]))
    assert r.metrics["trades"] == 0 and r.metrics["total_return"] == 0
    assert "沒有任何已平倉交易" in r.report()


def test_資料檢查():
    df = frame([100, 101, 102], [1, 0, 1])
    try:
        backtest(pd.concat([df, df.iloc[[0]]]))
        raise AssertionError("重複日期應報錯")
    except ValueError:
        pass
    bad = df.copy()
    bad.loc[1, "Close"] = np.nan
    try:
        backtest(bad)
        raise AssertionError("缺值收盤價應報錯")
    except ValueError:
        pass
    shuffled = backtest(df.iloc[::-1])
    assert any("排序" in n for n in shuffled.notes)


def test_日期放在_index_也能跑():
    df = frame([100, 110, 121], [1, 1, 0])
    a = backtest(df, costs=NO_MIN, whole_shares=False)
    b = backtest(df.set_index("Date"), costs=NO_MIN, whole_shares=False)
    close_to(a.metrics["total_return"], b.metrics["total_return"])


def test_機率訊號要提醒門檻():
    rng = np.random.default_rng(3)
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, 200)))
    prob = rng.random(200)
    r = backtest(frame(close, prob))
    assert any("signal_threshold" in n for n in r.notes), r.notes
    # 設定 0.5 門檻後，結果等同手動轉成 0/1
    a = backtest(frame(close, prob), signal_threshold=0.5)
    b = backtest(frame(close, (prob > 0.5).astype(int)))
    close_to(a.metrics["total_return"], b.metrics["total_return"])
    assert not any("signal_threshold" in n for n in a.notes)


if __name__ == "__main__":
    import sys
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")  # 輸出導向檔案時，Windows 繁中編碼（cp950）印不出 ✔ 等符號，不要因此中斷

    tests = [(k, v) for k, v in dict(globals()).items() if k.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"✔ {name}")
    print(f"\n全部 {len(tests)} 項通過")
