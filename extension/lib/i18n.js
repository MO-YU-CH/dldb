// 多言語辞書と DLsite 表示言語の検出。
//
// 表示言語は「ユーザーが DLsite で選んでいる言語」に従う。DLsite 側の真実は
// <html lang> と URL の ?locale= で、cookie の locale は locale 切り替え時に
// 更新されない（実測: ?locale=zh_CN で開いても cookie は ja-jp のまま）ため
// 最下位の手がかりとしてのみ使う。
(function () {
  'use strict';

  const PDP = (globalThis.PDP = globalThis.PDP || {});

  // DLsite の言語切り替え UI が持つ 14 言語（value は dlsite の locale 表記）
  const LOCALES = [
    { code: 'ja-jp', intl: 'ja-JP', label: '日本語' },
    { code: 'en-us', intl: 'en-US', label: 'English' },
    { code: 'zh-cn', intl: 'zh-CN', label: '简体中文' },
    { code: 'zh-tw', intl: 'zh-TW', label: '繁體中文' },
    { code: 'ko-kr', intl: 'ko-KR', label: '한국어' },
    { code: 'es-es', intl: 'es-ES', label: 'Español' },
    { code: 'de-de', intl: 'de-DE', label: 'Deutsch' },
    { code: 'fr-fr', intl: 'fr-FR', label: 'Français' },
    { code: 'id-id', intl: 'id-ID', label: 'Bahasa Indonesia' },
    { code: 'it-it', intl: 'it-IT', label: 'Italiano' },
    { code: 'pt-br', intl: 'pt-BR', label: 'Português' },
    { code: 'sv-se', intl: 'sv-SE', label: 'Svenska' },
    { code: 'th-th', intl: 'th-TH', label: 'ภาษาไทย' },
    { code: 'vi-vn', intl: 'vi-VN', label: 'Tiếng Việt' },
  ];

  const JA = {
    loading: '価格履歴を確認中...',
    noData: 'この作品の価格情報はまだ収集できていません',
    current: '現在価格',
    couponAfter: 'クーポン適用後',
    couponNone: '利用できるクーポンはありません',
    couponUsed: '適用クーポン',
    lowestCoupon: '最低価格（活動クーポン込み）',
    theoryLowest: '理論最安（限定配布込み）',
    viewBreakdown: '内訳を見る',
    multiBuy: 'まとめ買いを試算',
    breakdownTitle: '価格の組み立て',
    multiTitle: 'まとめ買いの試算',
    listPrice: '定価',
    shopDiscount: 'ストア割引',
    excludedTitle: '使えなかったクーポン',
    kindNewUser: '新規ユーザー券',
    kindCampaign: '活動券',
    kindQualified: '資格が必要な券',
    kindBlocked: '条件不一致',
    needCountBadge: '{n}点以上で利用可',
    officialNote: 'ページ表示 {price}',
    officialHint: 'この価格を正とする',
    officialDiff: 'ページは口径外の券（新規ユーザー券など）で算出しています',
    qtyUnit: '点',
    unitPrice: '1点あたり',
    multiHint: '券の本数条件を満たす部数だけが反映されます。まとめ買い・セット割のデータがあれば安い方を表示します。',
    cartNowAll: 'このまますべて買う',
    cartBestSplit: '分割が得（{n}回）',
    cartSaving: '{amount} お得',
    cartSplitNoGain: '分割しても安くならない',
    cartKeepAsIs: 'このまままとめて買うのが最安',
    cartPlanView: '分割の内訳と手順を見る',
    cartPlanTitle: '最安の買い方',
    cartOrderN: '第{n}回の会計',
    cartUseCoupon: 'クーポン',
    cartNoCoupon: 'クーポンなし',
    cartHowTo: '手順',
    cartStepMove: '第{n}回: 「{items}」だけ残して他を稍后再买へ → 会計',
    cartStepNote: 'これを{n}回繰り返し、最後に稍后再买から全部カートへ戻します。',
    cartPageShows: 'ページ表示のクーポン適用後: {price}',
    cartEstimateNote: '概算です。確定金額は購入手続き画面で確認してください。',
    cartBatchHint: '＝カート左側の番号。同じ番号をまとめて会計します。',
    cartNoCoupons: '所持クーポンを取得できませんでした',
    lowestPlain: '通常最安',
    lowestEver: '全期間最安',
    firstSeen: '収集開始日',
    samples: '記録 {n} 回',
    never: 'まだ記録がありません',
    cheapest: 'いま安いのは {store}（{price}）',
    samePrice: '現在は両売り場とも同価格',
    linkSite: '価格推移を詳しく見る →',
    error: '価格情報を取得できませんでした',
    recorded: '今回の価格を記録しました',
    recordOff: '記録は無効です',
    jpyBasis: '記録は日本円換算で保存します',
    history: 'この端末の記録',
    optTitle: '設定',
    optSubtitle: 'DLsite の作品ページで、クーポン適用後の最安値をこの端末に記録します。',
    optLangHint: '「合わせる」ではページの html lang と ?locale= から表示言語を判定します。',
    optLangMode: '表示言語',
    optLangAuto: 'DLsite の表示言語に合わせる',
    optLangForce: '言語を固定する',
    optRecord: '価格を記録する',
    optRecordHint: '作品ページを開くたびに、クーポン適用後の価格をこの端末に記録します。',
    optRecords: '記録した作品',
    optExport: 'JSON で書き出す',
    optClear: 'すべて削除',
    optEmpty: '記録はありません',
    optSaved: '保存しました',
    colWork: '作品',
    colPlain: '通常最安',
    colCoupon: '最低価格',
    colTheory: '理論最安',
    colSamples: '回数',
    colUpdated: '最終記録',
  };

  const EN = {
    loading: 'Checking price history...',
    noData: 'No price data has been collected for this work yet',
    current: 'Current price',
    couponAfter: 'After coupon',
    couponNone: 'No coupon available',
    couponUsed: 'Applied coupon',
    lowestCoupon: 'Lowest (campaign coupons)',
    theoryLowest: 'Theoretical low (qualified coupons)',
    viewBreakdown: 'How it is composed',
    multiBuy: 'Bulk estimate',
    breakdownTitle: 'How the price is built',
    multiTitle: 'Bulk purchase estimate',
    listPrice: 'List price',
    shopDiscount: 'Store discount',
    excludedTitle: 'Coupons not applied',
    kindNewUser: 'New-user coupons',
    kindCampaign: 'Campaign',
    kindQualified: 'Qualified coupons',
    kindBlocked: 'Conditions not met',
    needCountBadge: 'Needs {n}+ items',
    officialNote: 'Page shows {price}',
    officialHint: 'taken as authoritative',
    officialDiff: 'The page price is calculated with coupons outside this scope (new-user etc.)',
    qtyUnit: ' pcs',
    unitPrice: 'each',
    multiHint: 'Only coupons whose item-count condition is met apply. If bulk/set discount data exists, the cheaper one is shown.',
    cartNowAll: 'Buy all in one order',
    cartBestSplit: 'Splitting saves ({n} orders)',
    cartSaving: 'save {amount}',
    cartSplitNoGain: 'Splitting does not help',
    cartKeepAsIs: 'One order is already the cheapest',
    cartPlanView: 'See the split and the steps',
    cartPlanTitle: 'Cheapest way to buy',
    cartOrderN: 'Order {n}',
    cartUseCoupon: 'Coupon',
    cartNoCoupon: 'No coupon',
    cartHowTo: 'Steps',
    cartStepMove: 'Order {n}: keep only "{items}", move the rest to buy-later → checkout',
    cartStepNote: 'Repeat {n} times, then move everything back from buy-later.',
    cartPageShows: 'Page shows after coupon: {price}',
    cartEstimateNote: 'Estimate only. Confirm the final amount on the checkout screen.',
    cartBatchHint: '= the number on the left; check out the same numbers together.',
    cartNoCoupons: 'Could not load your coupons',
    lowestPlain: 'Lowest without coupon',
    lowestEver: 'All-time low',
    firstSeen: 'Tracking since',
    samples: '{n} records',
    never: 'No records yet',
    cheapest: 'Cheapest now: {store} ({price})',
    samePrice: 'Both stores are at the same price',
    linkSite: 'View full price history →',
    error: 'Could not load price information',
    recorded: 'Price recorded',
    recordOff: 'Recording is off',
    jpyBasis: 'Records are stored converted to JPY',
    history: 'Records on this device',
    optTitle: 'Settings',
    optSubtitle: 'Records the lowest coupon-adjusted price on DLsite work pages, on this device.',
    optLangHint: 'Auto mode reads the page html lang attribute and the ?locale= parameter.',
    optLangMode: 'Display language',
    optLangAuto: 'Follow DLsite display language',
    optLangForce: 'Force a language',
    optRecord: 'Record prices',
    optRecordHint: 'Each time you open a work page, the coupon-adjusted price is recorded on this device.',
    optRecords: 'Recorded works',
    optExport: 'Export JSON',
    optClear: 'Clear all',
    optEmpty: 'No records',
    optSaved: 'Saved',
    colWork: 'Work',
    colPlain: 'Lowest',
    colCoupon: 'Lowest',
    colTheory: 'Theoretical',
    colSamples: 'Samples',
    colUpdated: 'Updated',
  };

  const ZH_CN = {
    loading: '正在获取价格历史…',
    noData: '尚未收录该作品的价格信息',
    current: '当前价格',
    couponAfter: '券后价格',
    couponNone: '当前无可用优惠券',
    couponUsed: '已用优惠券',
    lowestCoupon: '最低价（含活动券）',
    theoryLowest: '理论最低（含资格券）',
    viewBreakdown: '查看组合',
    multiBuy: '多部购买',
    breakdownTitle: '价格组合',
    multiTitle: '多部购买试算',
    listPrice: '定价',
    shopDiscount: '店铺折扣',
    excludedTitle: '未采用的券',
    kindNewUser: '新用户券',
    kindCampaign: '活动券',
    kindQualified: '需资格券',
    kindBlocked: '条件不符',
    needCountBadge: '需 {n} 部以上',
    officialNote: '页面显示 {price}',
    officialHint: '以此为准',
    officialDiff: '页面价格使用了本口径外的券（新用户券等）',
    qtyUnit: ' 部',
    unitPrice: '单部',
    multiHint: '只有满足券的部数条件时才计入；若有まとめ買い/套装折扣数据，显示更便宜的一种。',
    cartNowAll: '一起买（当前）',
    cartBestSplit: '拆单更省（{n} 单）',
    cartSaving: '省 {amount}',
    cartSplitNoGain: '拆单不会更便宜',
    cartKeepAsIs: '保持一起买最省',
    cartPlanView: '查看拆分方案与操作步骤',
    cartPlanTitle: '最省的买法',
    cartOrderN: '第 {n} 单',
    cartUseCoupon: '用券',
    cartNoCoupon: '不用券',
    cartHowTo: '操作顺序',
    cartStepMove: '第 {n} 单：只留「{items}」，其余移到「稍后再买」→ 结算',
    cartStepNote: '按此重复 {n} 次，最后把「稍后再买」里的全部移回购物车。',
    cartPageShows: '页面显示券后：{price}',
    cartEstimateNote: '这是估算，最终金额以确认购买页为准。',
    cartBatchHint: '＝商品左侧的编号，同号的合并结算。',
    cartNoCoupons: '读取不到你的优惠券',
    lowestPlain: '无券历史最低',
    lowestEver: '全期间最低',
    firstSeen: '开始收录',
    samples: '已记录 {n} 次',
    never: '暂无记录',
    cheapest: '目前 {store} 更便宜（{price}）',
    samePrice: '当前两家同价',
    linkSite: '查看完整价格走势 →',
    error: '无法获取价格信息',
    recorded: '已记录本次价格',
    recordOff: '记录已关闭',
    jpyBasis: '记录以日元为基准换算保存',
    history: '本机记录',
    optTitle: '设置',
    optSubtitle: '在 DLsite 作品页记录含优惠券的最低价，数据仅保存在本机。',
    optLangHint: '“跟随”模式依据页面的 html lang 与 ?locale= 参数判定语言。',
    optLangMode: '显示语言',
    optLangAuto: '跟随 DLsite 显示语言',
    optLangForce: '固定为指定语言',
    optRecord: '记录价格',
    optRecordHint: '每次打开作品页，都会把券后价格记录在本机。',
    optRecords: '已记录的作品',
    optExport: '导出 JSON',
    optClear: '全部清空',
    optEmpty: '暂无记录',
    optSaved: '已保存',
    colWork: '作品',
    colPlain: '无券最低',
    colCoupon: '最低价',
    colTheory: '理论最低',
    colSamples: '次数',
    colUpdated: '最后记录',
  };

  const ZH_TW = {
    loading: '正在取得價格歷史…',
    noData: '尚未收錄此作品的價格資訊',
    current: '目前價格',
    couponAfter: '折價券後價格',
    couponNone: '目前沒有可用的折價券',
    couponUsed: '已使用折價券',
    lowestCoupon: '最低價（含活動券）',
    theoryLowest: '理論最低（含資格券）',
    viewBreakdown: '查看組合',
    multiBuy: '多部購買',
    breakdownTitle: '價格組合',
    multiTitle: '多部購買試算',
    listPrice: '定價',
    shopDiscount: '店鋪折扣',
    excludedTitle: '未採用的券',
    kindNewUser: '新用戶券',
    kindCampaign: '活動券',
    kindQualified: '需資格券',
    kindBlocked: '條件不符',
    needCountBadge: '需 {n} 部以上',
    officialNote: '頁面顯示 {price}',
    officialHint: '以此為準',
    officialDiff: '頁面價格使用了本口徑外的券（新用戶券等）',
    qtyUnit: ' 部',
    unitPrice: '單部',
    multiHint: '只有符合券的部數條件時才計入；若有まとめ買い/套裝折扣資料，顯示較便宜的一種。',
    cartNowAll: '一起買（目前）',
    cartBestSplit: '拆單更省（{n} 單）',
    cartSaving: '省 {amount}',
    cartSplitNoGain: '拆單不會更便宜',
    cartKeepAsIs: '保持一起買最省',
    cartPlanView: '查看拆分方案與操作步驟',
    cartPlanTitle: '最省的買法',
    cartOrderN: '第 {n} 單',
    cartUseCoupon: '用券',
    cartNoCoupon: '不用券',
    cartHowTo: '操作順序',
    cartStepMove: '第 {n} 單：只留「{items}」，其餘移到「稍後再買」→ 結帳',
    cartStepNote: '依此重複 {n} 次，最後把「稍後再買」裡的全部移回購物車。',
    cartPageShows: '頁面顯示折價券後：{price}',
    cartEstimateNote: '這是估算，最終金額以確認購買頁為準。',
    cartBatchHint: '＝商品左側的編號，同號的合併結帳。',
    cartNoCoupons: '讀取不到你的折價券',
    lowestPlain: '無券歷史最低',
    lowestEver: '全期間最低',
    firstSeen: '開始收錄',
    samples: '已記錄 {n} 次',
    never: '尚無記錄',
    cheapest: '目前 {store} 較便宜（{price}）',
    samePrice: '目前兩家同價',
    linkSite: '查看完整價格走勢 →',
    error: '無法取得價格資訊',
    recorded: '已記錄本次價格',
    recordOff: '記錄已關閉',
    jpyBasis: '記錄以日圓為基準換算保存',
    history: '本機記錄',
    optTitle: '設定',
    optSubtitle: '在 DLsite 作品頁記錄含折價券的最低價，資料僅保存在本機。',
    optLangHint: '「跟隨」模式依頁面的 html lang 與 ?locale= 參數判定語言。',
    optLangMode: '顯示語言',
    optLangAuto: '跟隨 DLsite 顯示語言',
    optLangForce: '固定為指定語言',
    optRecord: '記錄價格',
    optRecordHint: '每次開啟作品頁，都會把折價券後價格記錄在本機。',
    optRecords: '已記錄的作品',
    optExport: '匯出 JSON',
    optClear: '全部清除',
    optEmpty: '尚無記錄',
    optSaved: '已儲存',
    colWork: '作品',
    colPlain: '無券最低',
    colCoupon: '最低價',
    colTheory: '理論最低',
    colSamples: '次數',
    colUpdated: '最後記錄',
  };

  const KO_KR = {
    loading: '가격 기록을 확인하는 중...',
    noData: '아직 이 작품의 가격 정보가 수집되지 않았습니다',
    current: '현재 가격',
    couponAfter: '쿠폰 적용 후',
    couponNone: '사용 가능한 쿠폰이 없습니다',
    couponUsed: '적용 쿠폰',
    lowestCoupon: '최저가 (이벤트 쿠폰 포함)',
    theoryLowest: '이론 최저가 (자격 쿠폰 포함)',
    viewBreakdown: '구성 보기',
    multiBuy: '여러 개 구매',
    breakdownTitle: '가격 구성',
    multiTitle: '여러 개 구매 계산',
    listPrice: '정가',
    shopDiscount: '상점 할인',
    excludedTitle: '적용되지 않은 쿠폰',
    kindNewUser: '신규 유저 쿠폰',
    kindCampaign: '이벤트 쿠폰',
    kindQualified: '자격 필요 쿠폰',
    kindBlocked: '조건 불일치',
    needCountBadge: '{n}개 이상 필요',
    officialNote: '페이지 표시 {price}',
    officialHint: '이 가격을 기준으로 함',
    officialDiff: '페이지 가격은 이 기준 밖의 쿠폰(신규 유저 쿠폰 등)을 사용합니다',
    qtyUnit: '개',
    unitPrice: '개당',
    multiHint: '쿠폰의 개수 조건을 충족하는 수량만 반영됩니다. 묶음 구매/세트 할인 데이터가 있으면 더 저렴한 쪽을 표시합니다.',
    cartNowAll: '한 번에 모두 구매',
    cartBestSplit: '분할이 이득 ({n}회)',
    cartSaving: '{amount} 절약',
    cartSplitNoGain: '분할해도 저렴해지지 않음',
    cartKeepAsIs: '한 번에 사는 것이 최저가',
    cartPlanView: '분할 내역과 절차 보기',
    cartPlanTitle: '가장 저렴한 구매법',
    cartOrderN: '{n}번째 결제',
    cartUseCoupon: '쿠폰',
    cartNoCoupon: '쿠폰 없음',
    cartHowTo: '절차',
    cartStepMove: '{n}번째: "{items}"만 남기고 나머지를 나중에 구매로 이동 → 결제',
    cartStepNote: '{n}회 반복한 뒤, 나중에 구매에 있는 것을 모두 장바구니로 되돌립니다.',
    cartPageShows: '페이지 표시 쿠폰 적용 후: {price}',
    cartEstimateNote: '추정치입니다. 최종 금액은 구매 확인 화면에서 확인하세요.',
    cartBatchHint: '= 상품 왼쪽 번호. 같은 번호끼리 함께 결제합니다.',
    cartNoCoupons: '보유 쿠폰을 가져오지 못했습니다',
    lowestPlain: '일반 최저가',
    lowestEver: '전체 기간 최저가',
    firstSeen: '수집 시작일',
    samples: '{n}회 기록됨',
    never: '아직 기록이 없습니다',
    cheapest: '현재 {store}이(가) 더 저렴합니다 ({price})',
    samePrice: '현재 두 상점 가격이 같습니다',
    linkSite: '전체 가격 추이 보기 →',
    error: '가격 정보를 가져올 수 없습니다',
    recorded: '이번 가격을 기록했습니다',
    recordOff: '기록이 꺼져 있습니다',
    jpyBasis: '기록은 엔화 기준으로 환산해 저장합니다',
    history: '이 기기의 기록',
    optTitle: '설정',
    optSubtitle: 'DLsite 작품 페이지에서 쿠폰 적용 후 최저가를 이 기기에 기록합니다.',
    optLangHint: '자동 모드는 페이지의 html lang 속성과 ?locale= 값을 사용합니다.',
    optLangMode: '표시 언어',
    optLangAuto: 'DLsite 표시 언어 따르기',
    optLangForce: '언어 고정',
    optRecord: '가격 기록',
    optRecordHint: '작품 페이지를 열 때마다 쿠폰 적용 후 가격을 이 기기에 기록합니다.',
    optRecords: '기록된 작품',
    optExport: 'JSON 내보내기',
    optClear: '모두 삭제',
    optEmpty: '기록 없음',
    optSaved: '저장했습니다',
    colWork: '작품',
    colPlain: '일반 최저',
    colCoupon: '쿠폰 포함 최저',
    colTheory: '이론 최저가',
    colSamples: '횟수',
    colUpdated: '최종 기록',
  };

  const ES_ES = {
    loading: 'Consultando el historial de precios...',
    noData: 'Aún no hay datos de precio para esta obra',
    current: 'Precio actual',
    couponAfter: 'Precio con cupón',
    couponNone: 'No hay cupones disponibles',
    couponUsed: 'Cupón aplicado',
    lowestCoupon: 'Mínimo (cupones de campaña)',
    theoryLowest: 'Mínimo teórico (cupones restringidos)',
    viewBreakdown: 'Ver desglose',
    multiBuy: 'Compra múltiple',
    lowestPlain: 'Mínimo sin cupón',
    lowestEver: 'Mínimo histórico',
    firstSeen: 'Seguimiento desde',
    samples: '{n} registros',
    never: 'Aún sin registros',
    cheapest: 'Ahora más barato: {store} ({price})',
    samePrice: 'Ambas tiendas al mismo precio',
    linkSite: 'Ver historial completo →',
    error: 'No se pudo obtener la información de precios',
    recorded: 'Precio registrado',
    recordOff: 'El registro está desactivado',
    jpyBasis: 'Los registros se guardan convertidos a yenes',
    history: 'Registros en este dispositivo',
  };

  const DE_DE = {
    loading: 'Preisverlauf wird geladen...',
    noData: 'Für dieses Werk liegen noch keine Preisdaten vor',
    current: 'Aktueller Preis',
    couponAfter: 'Preis mit Gutschein',
    couponNone: 'Kein Gutschein verfügbar',
    couponUsed: 'Angewendeter Gutschein',
    lowestCoupon: 'Tiefstpreis (Aktionsgutscheine)',
    theoryLowest: 'Theoretischer Tiefstpreis (Qualifikationsgutscheine)',
    viewBreakdown: 'Aufschlüsselung',
    multiBuy: 'Mehrfachkauf',
    lowestPlain: 'Tiefstpreis ohne Gutschein',
    lowestEver: 'Allzeit-Tiefstpreis',
    firstSeen: 'Erfasst seit',
    samples: '{n} Einträge',
    never: 'Noch keine Einträge',
    cheapest: 'Günstiger jetzt: {store} ({price})',
    samePrice: 'Beide Shops zum gleichen Preis',
    linkSite: 'Vollen Preisverlauf ansehen →',
    error: 'Preisinformationen konnten nicht geladen werden',
    recorded: 'Preis gespeichert',
    recordOff: 'Erfassung ist aus',
    jpyBasis: 'Einträge werden in Yen umgerechnet gespeichert',
    history: 'Einträge auf diesem Gerät',
  };

  const FR_FR = {
    loading: "Vérification de l'historique des prix...",
    noData: 'Aucune donnée de prix pour cette œuvre',
    current: 'Prix actuel',
    couponAfter: 'Prix avec coupon',
    couponNone: 'Aucun coupon disponible',
    couponUsed: 'Coupon appliqué',
    lowestCoupon: 'Minimum (coupons promotionnels)',
    theoryLowest: 'Minimum théorique (coupons restreints)',
    viewBreakdown: 'Voir le détail',
    multiBuy: 'Achat multiple',
    lowestPlain: 'Minimum sans coupon',
    lowestEver: 'Minimum historique',
    firstSeen: 'Suivi depuis',
    samples: '{n} relevés',
    never: 'Aucun relevé',
    cheapest: 'Moins cher maintenant : {store} ({price})',
    samePrice: 'Les deux boutiques au même prix',
    linkSite: "Voir l'historique complet →",
    error: 'Impossible de récupérer les prix',
    recorded: 'Prix enregistré',
    recordOff: "L'enregistrement est désactivé",
    jpyBasis: 'Les relevés sont conservés convertis en yens',
    history: 'Relevés sur cet appareil',
  };

  const ID_ID = {
    loading: 'Memeriksa riwayat harga...',
    noData: 'Data harga karya ini belum terkumpul',
    current: 'Harga saat ini',
    couponAfter: 'Harga setelah kupon',
    couponNone: 'Tidak ada kupon tersedia',
    couponUsed: 'Kupon yang dipakai',
    lowestCoupon: 'Terendah (kupon kampanye)',
    theoryLowest: 'Terendah teoretis (kupon bersyarat)',
    viewBreakdown: 'Lihat rincian',
    multiBuy: 'Beli banyak',
    lowestPlain: 'Harga terendah tanpa kupon',
    lowestEver: 'Harga terendah sepanjang waktu',
    firstSeen: 'Dilacak sejak',
    samples: '{n} catatan',
    never: 'Belum ada catatan',
    cheapest: 'Lebih murah sekarang: {store} ({price})',
    samePrice: 'Kedua toko berharga sama',
    linkSite: 'Lihat riwayat harga lengkap →',
    error: 'Gagal memuat informasi harga',
    recorded: 'Harga telah dicatat',
    recordOff: 'Pencatatan nonaktif',
    jpyBasis: 'Catatan disimpan setelah dikonversi ke yen',
    history: 'Catatan di perangkat ini',
  };

  const IT_IT = {
    loading: 'Verifica dello storico prezzi...',
    noData: "Nessun dato di prezzo per quest'opera",
    current: 'Prezzo attuale',
    couponAfter: 'Prezzo con coupon',
    couponNone: 'Nessun coupon disponibile',
    couponUsed: 'Coupon applicato',
    lowestCoupon: 'Minimo (coupon campagna)',
    theoryLowest: 'Minimo teorico (coupon con requisiti)',
    viewBreakdown: 'Vedi dettaglio',
    multiBuy: 'Acquisto multiplo',
    lowestPlain: 'Minimo senza coupon',
    lowestEver: 'Minimo storico',
    firstSeen: 'Monitorato dal',
    samples: '{n} rilevazioni',
    never: 'Ancora nessuna rilevazione',
    cheapest: 'Ora più conveniente: {store} ({price})',
    samePrice: 'Entrambi gli store allo stesso prezzo',
    linkSite: 'Vedi lo storico completo →',
    error: 'Impossibile recuperare i prezzi',
    recorded: 'Prezzo registrato',
    recordOff: 'La registrazione è disattivata',
    jpyBasis: 'Le rilevazioni sono salvate convertite in yen',
    history: 'Rilevazioni su questo dispositivo',
  };

  const PT_BR = {
    loading: 'Verificando o histórico de preços...',
    noData: 'Ainda não há dados de preço para esta obra',
    current: 'Preço atual',
    couponAfter: 'Preço com cupom',
    couponNone: 'Nenhum cupom disponível',
    couponUsed: 'Cupom aplicado',
    lowestCoupon: 'Mínimo (cupons de campanha)',
    theoryLowest: 'Mínimo teórico (cupons restritos)',
    viewBreakdown: 'Ver detalhes',
    multiBuy: 'Compra múltipla',
    lowestPlain: 'Menor preço sem cupom',
    lowestEver: 'Menor preço histórico',
    firstSeen: 'Monitorado desde',
    samples: '{n} registros',
    never: 'Ainda sem registros',
    cheapest: 'Mais barato agora: {store} ({price})',
    samePrice: 'Ambas as lojas com o mesmo preço',
    linkSite: 'Ver histórico completo →',
    error: 'Não foi possível obter os preços',
    recorded: 'Preço registrado',
    recordOff: 'O registro está desativado',
    jpyBasis: 'Os registros são salvos convertidos em ienes',
    history: 'Registros neste dispositivo',
  };

  const SV_SE = {
    loading: 'Kontrollerar prishistorik...',
    noData: 'Inga prisuppgifter för detta verk ännu',
    current: 'Aktuellt pris',
    couponAfter: 'Pris med kupong',
    couponNone: 'Ingen kupong tillgänglig',
    couponUsed: 'Använd kupong',
    lowestCoupon: 'Lägsta (kampanjkuponger)',
    theoryLowest: 'Teoretiskt lägsta (kvalificerade kuponger)',
    viewBreakdown: 'Visa uppdelning',
    multiBuy: 'Flerköp',
    lowestPlain: 'Lägsta pris utan kupong',
    lowestEver: 'Lägsta pris någonsin',
    firstSeen: 'Spårat sedan',
    samples: '{n} poster',
    never: 'Inga poster ännu',
    cheapest: 'Billigast nu: {store} ({price})',
    samePrice: 'Båda butikerna till samma pris',
    linkSite: 'Se hela prishistoriken →',
    error: 'Kunde inte hämta prisuppgifter',
    recorded: 'Pris sparat',
    recordOff: 'Inspelning är avstängd',
    jpyBasis: 'Poster sparas omräknade till yen',
    history: 'Poster på den här enheten',
  };

  const TH_TH = {
    loading: 'กำลังตรวจสอบประวัติราคา...',
    noData: 'ยังไม่มีข้อมูลราคาของผลงานนี้',
    current: 'ราคาปัจจุบัน',
    couponAfter: 'ราคาหลังใช้คูปอง',
    couponNone: 'ไม่มีคูปองที่ใช้ได้',
    couponUsed: 'คูปองที่ใช้',
    lowestCoupon: 'ต่ำสุด (คูปองแคมเปญ)',
    theoryLowest: 'ต่ำสุดตามทฤษฎี (คูปองมีเงื่อนไข)',
    viewBreakdown: 'ดูรายละเอียด',
    multiBuy: 'ซื้อหลายชิ้น',
    lowestPlain: 'ราคาต่ำสุดเมื่อไม่ใช้คูปอง',
    lowestEver: 'ราคาต่ำสุดตลอดกาล',
    firstSeen: 'เริ่มเก็บข้อมูล',
    samples: 'บันทึกแล้ว {n} ครั้ง',
    never: 'ยังไม่มีบันทึก',
    cheapest: 'ตอนนี้ {store} ถูกกว่า ({price})',
    samePrice: 'ตอนนี้ทั้งสองร้านราคาเท่ากัน',
    linkSite: 'ดูประวัติราคาทั้งหมด →',
    error: 'ไม่สามารถดึงข้อมูลราคาได้',
    recorded: 'บันทึกราคาแล้ว',
    recordOff: 'ปิดการบันทึกอยู่',
    jpyBasis: 'บันทึกโดยแปลงเป็นเงินเยน',
    history: 'บันทึกในเครื่องนี้',
  };

  const VI_VN = {
    loading: 'Đang kiểm tra lịch sử giá...',
    noData: 'Chưa có dữ liệu giá cho tác phẩm này',
    current: 'Giá hiện tại',
    couponAfter: 'Giá sau khi dùng phiếu',
    couponNone: 'Không có phiếu giảm giá khả dụng',
    couponUsed: 'Phiếu đã áp dụng',
    lowestCoupon: 'Thấp nhất (phiếu chiến dịch)',
    theoryLowest: 'Thấp nhất lý thuyết (phiếu có điều kiện)',
    viewBreakdown: 'Xem chi tiết',
    multiBuy: 'Mua nhiều',
    lowestPlain: 'Giá thấp nhất không phiếu',
    lowestEver: 'Giá thấp nhất mọi thời đại',
    firstSeen: 'Theo dõi từ',
    samples: '{n} bản ghi',
    never: 'Chưa có bản ghi',
    cheapest: 'Hiện {store} rẻ hơn ({price})',
    samePrice: 'Hiện cả hai cửa hàng cùng giá',
    linkSite: 'Xem toàn bộ lịch sử giá →',
    error: 'Không lấy được thông tin giá',
    recorded: 'Đã ghi lại giá lần này',
    recordOff: 'Tính năng ghi đang tắt',
    jpyBasis: 'Bản ghi được quy đổi sang yên',
    history: 'Bản ghi trên thiết bị này',
  };

  const DICT = {
    'ja-jp': JA,
    'en-us': EN,
    'zh-cn': ZH_CN,
    'zh-tw': ZH_TW,
    'ko-kr': KO_KR,
    'es-es': ES_ES,
    'de-de': DE_DE,
    'fr-fr': FR_FR,
    'id-id': ID_ID,
    'it-it': IT_IT,
    'pt-br': PT_BR,
    'sv-se': SV_SE,
    'th-th': TH_TH,
    'vi-vn': VI_VN,
  };

  /** 表記ゆれ (zh_CN / zh-CN / ZH_cn) を dlsite 形式の小文字ハイフンに寄せる */
  function normalizeLocale(value) {
    if (!value) return null;
    const raw = String(value).trim().toLowerCase().replace(/_/g, '-');
    if (DICT[raw]) return raw;
    // 地域だけ違う場合 (zh-hk → zh-cn 等) は言語部分で寄せる
    const lang = raw.split('-')[0];
    const alias = {
      ja: 'ja-jp',
      en: 'en-us',
      zh: 'zh-cn',
      ko: 'ko-kr',
      es: 'es-es',
      de: 'de-de',
      fr: 'fr-fr',
      id: 'id-id',
      it: 'it-it',
      pt: 'pt-br',
      sv: 'sv-se',
      th: 'th-th',
      vi: 'vi-vn',
    };
    if (lang === 'zh') {
      if (raw.includes('tw') || raw.includes('hk') || raw.includes('hant')) return 'zh-tw';
      return 'zh-cn';
    }
    return alias[lang] || null;
  }

  /**
   * いま表示されている DLsite の言語を推定する。
   *
   * 優先順:
   *   1. URL の ?locale= (ユーザーが明示的に選んだ結果が URL に残る)
   *   2. <html lang> (サーバー / クライアントが実際に描画した言語。実測で追従する)
   *   3. cookie locale (切り替え時に更新されないため弱い手がかり)
   *   4. navigator.language
   */
  function detectLocale(doc, loc) {
    const d = doc || document;
    const l = loc || location;

    try {
      const param = new URL(l.href).searchParams.get('locale');
      const hit = normalizeLocale(param);
      if (hit) return hit;
    } catch (e) {
      // URL が壊れていても以降の手がかりで判定できる
    }

    const hit = normalizeLocale(d.documentElement.lang);
    if (hit) return hit;

    const cookie = String(d.cookie || '').match(/(?:^|;\s*)locale=([^;]+)/);
    if (cookie) {
      const c = normalizeLocale(decodeURIComponent(cookie[1]));
      if (c) return c;
    }

    return normalizeLocale(navigator.language) || 'ja-jp';
  }

  /** 設定 (言語固定) を踏まえた最終的な表示言語 */
  function resolveLocale(settings) {
    const mode = settings && settings.langMode;
    if (mode === 'fixed') {
      const fixed = normalizeLocale(settings.langOverride);
      if (fixed) return fixed;
    }
    return detectLocale();
  }

  function intlOf(code) {
    const meta = LOCALES.find((x) => x.code === code);
    return meta ? meta.intl : 'ja-JP';
  }

  /** 辞書引き。無い言語 / 無いキーは英語 → 日本語の順で落とす */
  function t(code, key, vars) {
    const dict = DICT[code] || DICT['ja-jp'];
    // 未訳のキーは英語を優先する (日本語に落ちると読み手を選ぶため)
    let text = dict[key];
    if (text === undefined) text = EN[key];
    if (text === undefined && code !== 'ja-jp') text = JA[key];
    if (text === undefined) return key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
    );
  }

  /**
   * 金額の整形。円は DLsite の日本語表示に合わせて「880円」、
   * それ以外は Intl の通貨書式に任せる。
   */
  function formatMoney(value, currency, code) {
    const cur = currency || 'JPY';
    const intl = intlOf(code);
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    const isInteger = Math.abs(n - Math.round(n)) < 0.005;
    if (cur === 'JPY' && code === 'ja-jp') {
      return `${Math.round(n).toLocaleString(intl)}円`;
    }
    try {
      return new Intl.NumberFormat(intl, {
        style: 'currency',
        currency: cur,
        maximumFractionDigits: cur === 'JPY' || isInteger ? 0 : 2,
      }).format(n);
    } catch (e) {
      return `${n.toLocaleString(intl)} ${cur}`;
    }
  }

  /** 日付 (YYYY-MM-DD or ISO) の表示 */
  function formatDate(value, code) {
    if (!value) return '-';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    try {
      return new Intl.DateTimeFormat(intlOf(code), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }

  PDP.i18n = {
    LOCALES,
    normalizeLocale,
    detectLocale,
    resolveLocale,
    t,
    formatMoney,
    formatDate,
    intlOf,
  };
})();
