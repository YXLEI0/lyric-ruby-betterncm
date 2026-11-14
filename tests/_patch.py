import subprocess

old = subprocess.run(
    ["git", "show", "HEAD:CHANGELOG.md"], capture_output=True, text=True, encoding="utf-8"
).stdout

# 旧文件里 1.32.3 那一段（从 "## 1.32.3" 到 "## 1.32.2" 之前）
i = old.find("## 1.32.3")
j = old.find("## 1.32.2", i)
sec1323 = old[i:j].rstrip() + "\n\n"

cur = open("CHANGELOG.md", encoding="utf-8").read()
k = cur.find("## 1.32.3")
l = cur.find("## 1.32.2", k)
new1324 = cur[k:l].replace("## 1.32.3", "## 1.32.4", 1)

head = "# 更新记录\n\n"
tail = cur[l:]
open("CHANGELOG.md", "w", encoding="utf-8").write(head + new1324.rstrip() + "\n\n" + sec1323 + tail)
print("ok")
