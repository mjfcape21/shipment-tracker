content = open('public/js/app.js', encoding='utf-8').read()
old = '    html+=esc(toTitle(p.name));\n    html+=\'<span class="filter-count">\'+count+\'</span>\';\n    html+=\'</button>\';'
new = '    html+=esc(toTitle(p.name));\n    html+=\'<span class="proj-edit-btn" title="Rename" onclick="event.stopPropagation();renameProject(\\\'\'+p.id+\'\\\',\\\'\'+p.name+\'\\\')">✏️</span>\';\n    html+=\'<span class="filter-count">\'+count+\'</span>\';\n    html+=\'</button>\';'
if old in content:
    open('public/js/app.js', 'w', encoding='utf-8').write(content.replace(old, new))
    print('Done!')
else:
    print('NOT FOUND')
