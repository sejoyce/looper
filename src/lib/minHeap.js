export class MinHeap {
  constructor() {
    this.items = []
  }
  get size() {
    return this.items.length
  }
  push(priority, value) {
    this.items.push([priority, value])
    let i = this.items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.items[parent][0] <= this.items[i][0]) break
      ;[this.items[parent], this.items[i]] = [this.items[i], this.items[parent]]
      i = parent
    }
  }
  pop() {
    if (this.items.length === 0) return null
    const top = this.items[0]
    const last = this.items.pop()
    if (this.items.length > 0) {
      this.items[0] = last
      let i = 0
      const n = this.items.length
      while (true) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let smallest = i
        if (l < n && this.items[l][0] < this.items[smallest][0]) smallest = l
        if (r < n && this.items[r][0] < this.items[smallest][0]) smallest = r
        if (smallest === i) break
        ;[this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]]
        i = smallest
      }
    }
    return top
  }
}
