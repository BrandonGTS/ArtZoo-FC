// 单元测试禁止真实网络和数据库连接（防止误发短信、QQ 或连到正式库）。
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => {
  throw new Error('单元测试禁止真实网络或数据库连接');
};
net.Socket.prototype.connect = deny;
net.Server.prototype.listen = deny;
tls.connect = deny;
dgram.Socket.prototype.send = deny;
dgram.Socket.prototype.bind = deny;
for (const name of ['lookup', 'resolve', 'resolveAny', 'resolve4', 'resolve6']) {
  dns[name] = deny;
  if (dns.promises[name]) dns.promises[name] = deny;
}
syncBuiltinESMExports();
